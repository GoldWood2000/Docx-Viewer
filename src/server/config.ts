import * as fs from 'fs';
import * as path from 'path';

export interface KBConfig {
    docxPath: string;
    databasePath: string;
    serverPort: number;
    pageSize: number;
}

export interface AIConfig {
    provider: string;
    apiBase: string;
    apiKey: string;
    model: string;
}

export interface AppConfig {
    kb: KBConfig;
    ai: AIConfig;
}

const DEFAULT_KB: KBConfig = {
    docxPath: './example_docx/知识库.docx',
    databasePath: './knowledge_base.db',
    serverPort: 3000,
    pageSize: 20
};

const DEFAULT_AI: AIConfig = {
    provider: 'openai',
    apiBase: '',
    apiKey: '',
    model: ''
};

export function loadConfig(): AppConfig {
    const configPath = path.resolve('docx-viewer.config.json');
    let fileKB: Partial<KBConfig> = {};
    let fileAI: Partial<AIConfig> = {};

    if (fs.existsSync(configPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            fileKB = raw.knowledgeBase || {};
            fileAI = raw.ai || {};
        } catch {
            console.warn('Failed to parse config file, using defaults.');
        }
    }

    const args = process.argv.slice(2);
    const cliConfig: Partial<KBConfig> = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--docx' && args[i + 1]) { cliConfig.docxPath = args[++i]; }
        if (args[i] === '--db' && args[i + 1]) { cliConfig.databasePath = args[++i]; }
        if (args[i] === '--port' && args[i + 1]) { cliConfig.serverPort = parseInt(args[++i]); }
    }

    return {
        kb: { ...DEFAULT_KB, ...fileKB, ...cliConfig },
        ai: { ...DEFAULT_AI, ...fileAI }
    };
}
