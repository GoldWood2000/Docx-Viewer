import express from 'express';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { loadConfig, type AIConfig } from './config';
import { createChatHandler } from './chat_handler';

export function startServer(dbPath: string, port: number, aiConfig?: AIConfig): void {
    const resolvedDbPath = path.resolve(dbPath);

    if (!fs.existsSync(resolvedDbPath)) {
        console.error(`Database not found: ${resolvedDbPath}`);
        console.error('Run "npm run preprocess" first to build the search index.');
        process.exit(1);
    }

    const db = new Database(resolvedDbPath);
    db.pragma('journal_mode = WAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS qa_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            section_id INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS qa_cache_fts USING fts5(
            question, content='qa_cache', content_rowid='id', tokenize='trigram'
        )
    `);
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS qa_fts_ai AFTER INSERT ON qa_cache BEGIN
            INSERT INTO qa_cache_fts(rowid, question) VALUES (new.id, new.question);
        END
    `);
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS qa_fts_ad AFTER DELETE ON qa_cache BEGIN
            INSERT INTO qa_cache_fts(qa_cache_fts, rowid, question) VALUES('delete', old.id, old.question);
        END
    `);
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS qa_fts_au AFTER UPDATE ON qa_cache BEGIN
            INSERT INTO qa_cache_fts(qa_cache_fts, rowid, question) VALUES('delete', old.id, old.question);
            INSERT INTO qa_cache_fts(rowid, question) VALUES (new.id, new.question);
        END
    `);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_question ON qa_cache(question)');

    const app = express();
    app.use(express.json());

    const webDir = path.join(__dirname, '..', '..', 'src', 'server', 'web');
    const altWebDir = path.join(__dirname, 'web');

    const staticDir = fs.existsSync(webDir) ? webDir : altWebDir;
    app.use(express.static(staticDir));

    app.get('/api/search', (req, res) => {
        const query = (req.query.q as string || '').trim();
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const offset = (page - 1) * limit;

        if (!query || query.length < 1) {
            return res.json({ results: [], qaResults: [], total: 0, page, limit });
        }

        try {
            let qaResults: unknown[] = [];
            const needsLikeQA = query.length < 3 || /^[\u4e00-\u9fff]{1,2}$/.test(query);
            if (needsLikeQA) {
                const likePattern = `%${query}%`;
                qaResults = db.prepare(`
                    SELECT id, question, answer, section_id, created_at
                    FROM qa_cache WHERE question LIKE ?
                    ORDER BY created_at DESC LIMIT 5
                `).all(likePattern);
            } else {
                const escapedQA = `"${query.replace(/"/g, '""')}"`;
                try {
                    qaResults = db.prepare(`
                        SELECT q.id, q.question, q.answer, q.section_id, q.created_at
                        FROM qa_cache_fts
                        JOIN qa_cache q ON q.id = qa_cache_fts.rowid
                        WHERE qa_cache_fts MATCH ?
                        ORDER BY bm25(qa_cache_fts) LIMIT 5
                    `).all(escapedQA);
                } catch { qaResults = []; }
            }

            let results: unknown[];
            let total: number;

            const needsLikeFallback = query.length < 3 || /^[\u4e00-\u9fff]{1,2}$/.test(query);

            if (needsLikeFallback) {
                const likePattern = `%${query}%`;

                const countResult = db.prepare(`
                    SELECT count(*) as total FROM sections
                    WHERE heading LIKE ? OR text_content LIKE ?
                `).get(likePattern, likePattern) as { total: number };
                total = countResult.total;

                results = db.prepare(`
                    SELECT id, heading, heading_level, parent_heading, heading_id, section_order,
                           substr(text_content, max(1, instr(lower(text_content), lower(?)) - 60), 200) as snippet
                    FROM sections
                    WHERE heading LIKE ? OR text_content LIKE ?
                    ORDER BY section_order
                    LIMIT ? OFFSET ?
                `).all(query, likePattern, likePattern, limit, offset);
            } else {
                const escapedQuery = `"${query.replace(/"/g, '""')}"`;

                const countResult = db.prepare(`
                    SELECT count(*) as total FROM sections_fts WHERE sections_fts MATCH ?
                `).get(escapedQuery) as { total: number };
                total = countResult.total;

                results = db.prepare(`
                    SELECT s.id, s.heading, s.heading_level, s.parent_heading, s.heading_id, s.section_order,
                           snippet(sections_fts, 1, '<mark>', '</mark>', '...', 64) as snippet
                    FROM sections_fts
                    JOIN sections s ON s.id = sections_fts.rowid
                    WHERE sections_fts MATCH ?
                    ORDER BY bm25(sections_fts)
                    LIMIT ? OFFSET ?
                `).all(escapedQuery, limit, offset);
            }

            res.json({
                results,
                qaResults,
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Search failed';
            res.status(400).json({ error: message });
        }
    });

    app.post('/api/chat', createChatHandler(db));

    app.get('/api/section/:id', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json({ error: 'Invalid section ID' });
        }

        const section = db.prepare(`
            SELECT id, heading, heading_level, parent_heading, heading_id, html_content, section_order
            FROM sections WHERE id = ?
        `).get(id);

        if (!section) {
            return res.status(404).json({ error: 'Section not found' });
        }
        res.json(section);
    });

    app.get('/api/outline', (_req, res) => {
        const outline = db.prepare(`
            SELECT id, heading, heading_level, parent_heading, heading_id, section_order
            FROM sections ORDER BY section_order
        `).all();
        res.json(outline);
    });

    app.get('/api/stats', (_req, res) => {
        const rows = db.prepare('SELECT key, value FROM metadata').all() as Array<{ key: string; value: string }>;
        const stats: Record<string, string> = {};
        for (const row of rows) {
            stats[row.key] = row.value;
        }
        res.json(stats);
    });

    app.get('/api/ai-config', (_req, res) => {
        res.json(aiConfig || { provider: '', apiBase: '', apiKey: '', model: '' });
    });

    app.post('/api/qa', (req, res) => {
        const { question, answer, section_id } = req.body;
        if (!question || !answer) {
            return res.status(400).json({ error: 'Missing question or answer' });
        }

        try {
            const stmt = db.prepare(`
                INSERT INTO qa_cache (question, answer, section_id, created_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(question) DO UPDATE SET
                    answer = excluded.answer,
                    section_id = excluded.section_id,
                    created_at = datetime('now')
            `);
            const result = stmt.run(question, answer, section_id || null);
            res.json({ id: result.lastInsertRowid });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Failed to save QA';
            res.status(500).json({ error: message });
        }
    });

    app.delete('/api/qa/:id', (req, res) => {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json({ error: 'Invalid QA ID' });
        }
        try {
            const result = db.prepare('DELETE FROM qa_cache WHERE id = ?').run(id);
            res.json({ deleted: result.changes > 0 });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Failed to delete QA';
            res.status(500).json({ error: message });
        }
    });

    const server = app.listen(port, () => {
        console.log(`\n  Knowledge Base server running at http://localhost:${port}\n`);
    });

    const shutdown = () => {
        console.log('\nShutting down...');
        server.close();
        db.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    const config = loadConfig();
    startServer(config.kb.databasePath, config.kb.serverPort, config.ai);
}
