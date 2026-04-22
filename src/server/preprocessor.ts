import * as mammoth from 'mammoth';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { loadConfig } from './config';

interface SectionData {
    heading: string;
    headingLevel: number;
    parentHeading: string | null;
    headingId: string;
    htmlContent: string;
    textContent: string;
    sectionOrder: number;
}

function computeFileHash(filePath: string): string {
    const hash = crypto.createHash('sha256');
    const stream = fs.readFileSync(filePath);
    hash.update(stream);
    return hash.digest('hex');
}

function generateHeadingId(text: string, index: number): string {
    const baseId = text.toLowerCase()
        .replace(/[^\w\s\u4e00-\u9fff-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 50);
    return `${baseId || 'section'}-${index}`;
}

function stripHtmlTags(html: string): string {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitHtmlIntoSections(html: string): SectionData[] {
    const sections: SectionData[] = [];
    const headingPattern = /<h([12])[^>]*>([\s\S]*?)<\/h[12]>/gi;

    const headings: Array<{
        index: number;
        endIndex: number;
        level: number;
        text: string;
        fullMatch: string;
    }> = [];

    let match: RegExpExecArray | null;
    while ((match = headingPattern.exec(html)) !== null) {
        headings.push({
            index: match.index,
            endIndex: match.index + match[0].length,
            level: parseInt(match[1]),
            text: match[2].replace(/<[^>]*>/g, '').trim(),
            fullMatch: match[0]
        });
    }

    if (headings.length === 0) {
        sections.push({
            heading: '全文',
            headingLevel: 1,
            parentHeading: null,
            headingId: 'full-document',
            htmlContent: html,
            textContent: stripHtmlTags(html),
            sectionOrder: 0
        });
        return sections;
    }

    let currentH1: string | null = null;
    let sectionOrder = 0;

    if (headings[0].index > 0) {
        const introContent = html.substring(0, headings[0].index).trim();
        if (introContent && stripHtmlTags(introContent).length > 0) {
            sections.push({
                heading: '前言',
                headingLevel: 1,
                parentHeading: null,
                headingId: 'introduction',
                htmlContent: introContent,
                textContent: stripHtmlTags(introContent),
                sectionOrder: sectionOrder++
            });
        }
    }

    for (let i = 0; i < headings.length; i++) {
        const heading = headings[i];
        const nextIndex = (i + 1 < headings.length) ? headings[i + 1].index : html.length;

        if (heading.level === 1) {
            currentH1 = heading.text;
        }

        const bodyHtml = html.substring(heading.endIndex, nextIndex).trim();
        const fullHtml = heading.fullMatch + bodyHtml;

        if (!heading.text && !bodyHtml) {
            continue;
        }

        sections.push({
            heading: heading.text || '(无标题)',
            headingLevel: heading.level,
            parentHeading: heading.level === 2 ? currentH1 : null,
            headingId: generateHeadingId(heading.text, sectionOrder),
            htmlContent: fullHtml,
            textContent: stripHtmlTags(fullHtml),
            sectionOrder: sectionOrder++
        });
    }

    return sections;
}

function initializeDatabase(db: Database.Database): void {
    db.pragma('journal_mode = WAL');

    db.exec(`
        DROP TABLE IF EXISTS sections_fts;
        DROP TABLE IF EXISTS sections;
        DROP TABLE IF EXISTS metadata;

        CREATE TABLE sections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            heading TEXT NOT NULL,
            heading_level INTEGER NOT NULL,
            parent_heading TEXT,
            heading_id TEXT NOT NULL,
            html_content TEXT NOT NULL,
            text_content TEXT NOT NULL,
            section_order INTEGER NOT NULL
        );

        CREATE VIRTUAL TABLE sections_fts USING fts5(
            heading, text_content,
            content='sections', content_rowid='id',
            tokenize='trigram'
        );

        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);
}

export async function preprocessDocx(docxPath: string, dbPath: string): Promise<void> {
    const absolutePath = path.resolve(docxPath);

    if (!fs.existsSync(absolutePath)) {
        console.error(`File not found: ${absolutePath}`);
        process.exit(1);
    }

    console.log(`Computing file hash...`);
    const fileHash = computeFileHash(absolutePath);

    if (fs.existsSync(dbPath)) {
        try {
            const existingDb = new Database(dbPath, { readonly: true });
            const stored = existingDb.prepare('SELECT value FROM metadata WHERE key = ?').get('file_hash') as { value: string } | undefined;
            existingDb.close();
            if (stored && stored.value === fileHash) {
                console.log('Database is up to date, skipping rebuild.');
                return;
            }
        } catch {
            // database corrupt or schema mismatch, rebuild
        }
    }

    console.log(`Reading ${absolutePath} (${(fs.statSync(absolutePath).size / 1024 / 1024).toFixed(1)} MB)...`);
    const buffer = fs.readFileSync(absolutePath);

    console.log('Converting docx to HTML (this may take a while for large files)...');
    const startTime = Date.now();
    const result = await mammoth.convertToHtml({ buffer: buffer });
    const conversionTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Conversion complete in ${conversionTime}s. HTML length: ${(result.value.length / 1024 / 1024).toFixed(1)} MB`);

    if (result.messages.length > 0) {
        const warnings = result.messages.slice(0, 5).map(m => m.message);
        console.log(`Mammoth warnings (${result.messages.length} total): ${warnings.join('; ')}${result.messages.length > 5 ? '...' : ''}`);
    }

    console.log('Splitting into sections by H1/H2 headings...');
    const sections = splitHtmlIntoSections(result.value);
    console.log(`Found ${sections.length} sections.`);

    console.log('Building SQLite FTS5 index...');
    const db = new Database(dbPath);
    initializeDatabase(db);

    const insert = db.prepare(`
        INSERT INTO sections (heading, heading_level, parent_heading, heading_id, html_content, text_content, section_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((items: SectionData[]) => {
        for (const s of items) {
            insert.run(s.heading, s.headingLevel, s.parentHeading, s.headingId, s.htmlContent, s.textContent, s.sectionOrder);
        }
    });

    insertMany(sections);

    db.exec(`INSERT INTO sections_fts(sections_fts) VALUES('rebuild')`);

    const upsertMeta = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
    upsertMeta.run('file_hash', fileHash);
    upsertMeta.run('build_time', new Date().toISOString());
    upsertMeta.run('total_sections', sections.length.toString());
    upsertMeta.run('source_file', absolutePath);

    db.close();

    const dbSize = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1);
    console.log(`Done! Database saved to ${dbPath} (${dbSize} MB) with ${sections.length} sections.`);
}

if (require.main === module) {
    const config = loadConfig();
    preprocessDocx(config.kb.docxPath, config.kb.databasePath).catch(err => {
        console.error('Preprocessing failed:', err);
        process.exit(1);
    });
}
