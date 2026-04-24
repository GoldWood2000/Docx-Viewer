import type { Request, Response } from 'express';
import type Database from 'better-sqlite3';
import type { AIConfig } from './config';
import { embedQuery, vectorSearch } from './vector_search';

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

export interface ChatHandlerOptions {
    aiConfig?: AIConfig;
    embeddingsCache?: Map<number, number[]> | null;
    vectorSearchEnabled?: boolean;
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
                ORDER BY
                    CASE WHEN heading LIKE '%\u5e38\u89c1\u95ee\u9898%' THEN 0 ELSE 1 END,
                    section_order
                LIMIT ?
            `).all(pattern, pattern, limit) as Array<{ heading: string; text_content: string }>;
        } else {
            const escaped = `"${query.replace(/"/g, '""')}"`;
            rows = db.prepare(`
                SELECT s.heading, substr(s.text_content, 1, 2000) as text_content
                FROM sections_fts
                JOIN sections s ON s.id = sections_fts.rowid
                WHERE sections_fts MATCH ?
                ORDER BY
                    CASE WHEN s.heading LIKE '%\u5e38\u89c1\u95ee\u9898%' THEN 0 ELSE 1 END,
                    bm25(sections_fts)
                LIMIT ?
            `).all(escaped, limit) as Array<{ heading: string; text_content: string }>;
        }

        return rows.map(r => `## ${r.heading}\n${r.text_content}`);
    } catch {
        return [];
    }
}

async function searchRelevantSectionsHybrid(
    db: Database.Database,
    query: string,
    options: ChatHandlerOptions | undefined,
    limit: number = 5
): Promise<string[]> {
    const ftsResults = searchRelevantSections(db, query, limit);

    if (!options?.vectorSearchEnabled || !options?.embeddingsCache || !options?.aiConfig?.apiKey) {
        return ftsResults;
    }

    try {
        const ai = options.aiConfig;
        const queryEmb = await embedQuery(
            query,
            ai.apiBase,
            ai.apiKey,
            ai.embeddingModel || 'text-embedding-v3',
            ai.embeddingDimensions || 1024
        );
        if (!queryEmb) { return ftsResults; }

        const vecResults = vectorSearch(queryEmb, options.embeddingsCache, limit);

        const seen = new Set(ftsResults);
        const additions: string[] = [];

        for (const vr of vecResults) {
            if (ftsResults.length + additions.length >= limit) { break; }
            const row = db.prepare(
                'SELECT heading, substr(text_content, 1, 2000) as text_content FROM sections WHERE id = ?'
            ).get(vr.sectionId) as { heading: string; text_content: string } | undefined;
            if (row) {
                const text = `## ${row.heading}\n${row.text_content}`;
                if (!seen.has(text)) {
                    additions.push(text);
                    seen.add(text);
                }
            }
        }

        return [...ftsResults, ...additions].slice(0, limit);
    } catch {
        return ftsResults;
    }
}

function buildSystemPrompt(contextSections: string[]): string {
    const base = `你是解悠客服部客服助手，严格遵守以下规则：
1. 只能根据下方提供的知识库内容回答问题，不得自行发散或补充知识库以外的信息。
2. **优先围绕知识库中的"常见问题"章节进行回答**：
   - 如果用户问题能匹配到"常见问题"中的某条 FAQ，请直接复用该 FAQ 的"处理方案"和"对客响应"内容作答。
   - 回答应当贴合客服话术风格，参照知识库中"对客响应"的语气和模板。
   - 若有多条相关 FAQ，请逐条列出，每条标注其问题标题。
3. 如果知识库中没有相关 FAQ 或内容，直接回复"抱歉，这个问题我暂时无法解答。"，不要编造任何内容。
4. 绝对不能编造、猜测或推断知识库未提及的信息。
5. 回答请分点列出，关键步骤用**加粗**标注，操作流程按顺序编号。
6. 你的职责是基于"常见问题"做答复，而不是创作新内容。`;

    if (contextSections.length === 0) {
        return base + '\n\n当前没有检索到相关知识库内容。请直接回复"抱歉，这个问题我暂时无法解答。"';
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

export function createChatHandler(db: Database.Database, options?: ChatHandlerOptions) {
    return async (req: Request, res: Response): Promise<void> => {
        const { messages, apiBase, apiKey, model, provider } = req.body as ChatRequest;

        console.log(`[chat] provider=${provider} apiBase=${apiBase} model=${model} apiKey=${apiKey ? '***' + apiKey.slice(-4) : '(empty)'}`);

        if (!apiKey || !apiBase || !model || !messages || messages.length === 0) {
            res.status(400).json({ error: 'Missing required fields: apiBase, apiKey, model, messages' });
            return;
        }

        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        const query = lastUserMsg?.content || '';

        const contextSections = await searchRelevantSectionsHybrid(db, query, options);
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
