import type { Request, Response } from 'express';
import type Database from 'better-sqlite3';

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

interface ChatRequest {
    messages: ChatMessage[];
    apiBase: string;
    apiKey: string;
    model: string;
    provider: 'openai' | 'anthropic';
}

function searchRelevantSections(db: Database.Database, query: string, limit: number = 5): string[] {
    if (!query || query.length < 1) { return []; }

    try {
        const needsLike = query.length < 3 || /^[\u4e00-\u9fff]{1,2}$/.test(query);
        let rows: Array<{ heading: string; text_content: string }>;

        if (needsLike) {
            const pattern = `%${query}%`;
            rows = db.prepare(`
                SELECT heading, substr(text_content, 1, 2000) as text_content
                FROM sections
                WHERE heading LIKE ? OR text_content LIKE ?
                ORDER BY section_order
                LIMIT ?
            `).all(pattern, pattern, limit) as Array<{ heading: string; text_content: string }>;
        } else {
            const escaped = `"${query.replace(/"/g, '""')}"`;
            rows = db.prepare(`
                SELECT s.heading, substr(s.text_content, 1, 2000) as text_content
                FROM sections_fts
                JOIN sections s ON s.id = sections_fts.rowid
                WHERE sections_fts MATCH ?
                ORDER BY bm25(sections_fts)
                LIMIT ?
            `).all(escaped, limit) as Array<{ heading: string; text_content: string }>;
        }

        return rows.map(r => `## ${r.heading}\n${r.text_content}`);
    } catch {
        return [];
    }
}

function buildSystemPrompt(contextSections: string[]): string {
    const base = '你是一个专业的知识库客服助手。请根据以下知识库内容来回答用户的问题。如果知识库中没有相关信息，请如实告知用户。回答要准确、简洁、有条理。';

    if (contextSections.length === 0) {
        return base + '\n\n当前没有检索到相关知识库内容，请根据已有对话上下文尽力回答。';
    }

    return base + '\n\n以下是从知识库中检索到的相关内容：\n\n' + contextSections.join('\n\n---\n\n');
}

async function streamOpenAI(apiBase: string, apiKey: string, model: string, systemPrompt: string, messages: ChatMessage[], res: Response): Promise<void> {
    const url = apiBase.replace(/\/+$/, '') + '/chat/completions';

    const body = {
        model,
        stream: true,
        max_tokens: 4096,
        messages: [
            { role: 'system', content: systemPrompt },
            ...messages.map(m => ({ role: m.role, content: m.content }))
        ]
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errText = await response.text();
        res.write(`data: ${JSON.stringify({ error: `API error ${response.status}: ${errText}` })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
    }

    const reader = response.body?.getReader();
    if (!reader) { res.end(); return; }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
            const data = trimmed.slice(6);

            if (data === '[DONE]') {
                res.write('data: [DONE]\n\n');
                continue;
            }

            try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) {
                    res.write(`data: ${JSON.stringify({ content })}\n\n`);
                }
            } catch {
                // skip malformed chunks
            }
        }
    }

    res.write('data: [DONE]\n\n');
    res.end();
}

async function streamAnthropic(apiBase: string, apiKey: string, model: string, systemPrompt: string, messages: ChatMessage[], res: Response): Promise<void> {
    const url = apiBase.replace(/\/+$/, '') + '/messages';

    const body = {
        model,
        max_tokens: 4096,
        stream: true,
        system: systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content }))
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errText = await response.text();
        res.write(`data: ${JSON.stringify({ error: `API error ${response.status}: ${errText}` })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
    }

    const reader = response.body?.getReader();
    if (!reader) { res.end(); return; }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
            const data = trimmed.slice(6);

            if (data === '[DONE]') { continue; }

            try {
                const parsed = JSON.parse(data);
                if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                    res.write(`data: ${JSON.stringify({ content: parsed.delta.text })}\n\n`);
                }
                if (parsed.type === 'message_stop') {
                    res.write('data: [DONE]\n\n');
                }
            } catch {
                // skip
            }
        }
    }

    res.write('data: [DONE]\n\n');
    res.end();
}

export function createChatHandler(db: Database.Database) {
    return async (req: Request, res: Response): Promise<void> => {
        const { messages, apiBase, apiKey, model, provider } = req.body as ChatRequest;

        console.log(`[chat] provider=${provider} apiBase=${apiBase} model=${model} apiKey=${apiKey ? '***' + apiKey.slice(-4) : '(empty)'}`);

        if (!apiKey || !apiBase || !model || !messages || messages.length === 0) {
            res.status(400).json({ error: 'Missing required fields: apiBase, apiKey, model, messages' });
            return;
        }

        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        const query = lastUserMsg?.content || '';

        const contextSections = searchRelevantSections(db, query);
        const systemPrompt = buildSystemPrompt(contextSections);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        try {
            if (provider === 'anthropic') {
                await streamAnthropic(apiBase, apiKey, model, systemPrompt, messages, res);
            } else {
                await streamOpenAI(apiBase, apiKey, model, systemPrompt, messages, res);
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    };
}
