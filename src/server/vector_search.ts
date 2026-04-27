import type Database from 'better-sqlite3';

export function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

export async function embedTexts(
    texts: string[],
    apiBase: string,
    apiKey: string,
    model: string,
    dimensions: number,
    batchSize: number = 10
): Promise<(number[] | null)[]> {
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const url = apiBase.replace(/\/+$/, '') + '/embeddings';

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model,
                    input: batch,
                    dimensions,
                    encoding_format: 'float'
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                console.warn(`Embedding batch ${i}-${i + batch.length} failed (${response.status}): ${errText}`);
                continue;
            }

            const data = await response.json() as {
                data: Array<{ index: number; embedding: number[] }>;
            };

            for (const item of data.data) {
                results[i + item.index] = item.embedding;
            }
        } catch (err) {
            console.warn(`Embedding batch ${i}-${i + batch.length} error:`, err);
        }
    }

    return results;
}

export async function embedQuery(
    query: string,
    apiBase: string,
    apiKey: string,
    model: string,
    dimensions: number
): Promise<number[] | null> {
    const results = await embedTexts([query], apiBase, apiKey, model, dimensions, 1);
    return results[0];
}

export function vectorSearch(
    queryEmbedding: number[],
    embeddingsCache: Map<number, number[]>,
    topK: number = 20
): Array<{ sectionId: number; score: number }> {
    const results: Array<{ sectionId: number; score: number }> = [];
    for (const [sectionId, embedding] of embeddingsCache) {
        const score = cosineSimilarity(queryEmbedding, embedding);
        results.push({ sectionId, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}

export function loadEmbeddingsCache(db: Database.Database): Map<number, number[]> | null {
    try {
        const rows = db.prepare(
            'SELECT section_id, embedding FROM section_embeddings'
        ).all() as Array<{ section_id: number; embedding: string }>;

        if (rows.length === 0) { return null; }

        const cache = new Map<number, number[]>();
        for (const row of rows) {
            cache.set(row.section_id, JSON.parse(row.embedding));
        }
        console.log(`Loaded ${cache.size} section embeddings into cache.`);
        return cache;
    } catch {
        return null;
    }
}
