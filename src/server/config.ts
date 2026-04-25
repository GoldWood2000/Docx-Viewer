import * as fs from 'fs';
import * as path from 'path';

export interface KBConfig {
    docxPath: string;
    databasePath: string;
    serverPort: number;
    pageSize: number;
    enableVectorSearch: boolean;
}

export interface AIConfig {
    provider: string;
    apiBase: string;
    apiKey: string;
    model: string;
    embeddingModel: string;
    embeddingDimensions: number;
}

export interface UIConfig {
    collapseProcess: boolean;
    collapseFaq: boolean;
}

export interface AppConfig {
    kb: KBConfig;
    ai: AIConfig;
    ui: UIConfig;
}

const DEFAULT_KB: KBConfig = {
    docxPath: './example_docx/知识库.docx',
    databasePath: './knowledge_base.db',
    serverPort: 3000,
    pageSize: 20,
    enableVectorSearch: true
};

const DEFAULT_AI: AIConfig = {
    provider: 'openai',
    apiBase: '',
    apiKey: '',
    model: '',
    embeddingModel: 'text-embedding-v3',
    embeddingDimensions: 1024
};

const DEFAULT_UI: UIConfig = {
    collapseProcess: true,
    collapseFaq: false
};

export function loadConfig(): AppConfig {
    const configPath = path.resolve('docx-viewer.config.json');
    let fileKB: Partial<KBConfig> = {};
    let fileAI: Partial<AIConfig> = {};
    let fileUI: Partial<UIConfig> = {};

    if (fs.existsSync(configPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            fileKB = raw.knowledgeBase || {};
            fileAI = raw.ai || {};
            fileUI = raw.ui || {};
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
        ai: { ...DEFAULT_AI, ...fileAI },
        ui: { ...DEFAULT_UI, ...fileUI }
    };
}
