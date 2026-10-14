import { parentPort, workerData } from 'worker_threads';
import { JaiTokenizer } from './tokenizer';
import { buildOutline } from './outline';
import {
    flattenWorkspaceSymbols,
    type WorkspaceSymbolRecord,
} from './workspaceSymbolCore';

/**
 * Worker-thread half of the workspace symbol index.
 *
 * Each worker owns one JaiTokenizer (grammar + Oniguruma WASM load once per
 * thread) and processes batches of whole files: tokenize -> outline ->
 * flattened records. Only the flat records cross back to the main thread;
 * source text goes in, symbol records come out, nothing else is shared.
 * Errors are reported per file so one bad file cannot fail a whole batch.
 */

export interface WorkspaceWorkerFileInput {
    uri: string;
    text: string;
}

export interface WorkspaceWorkerFileResult {
    uri: string;
    records: WorkspaceSymbolRecord[];
    error?: string;
}

export interface WorkspaceWorkerTask {
    id: number;
    files: WorkspaceWorkerFileInput[];
}

export interface WorkspaceWorkerResult {
    id: number;
    results: WorkspaceWorkerFileResult[];
}

interface WorkerInit {
    grammarPath: string;
}

if (parentPort) {
    const port = parentPort;
    const { grammarPath } = workerData as WorkerInit;
    const tokenizer = new JaiTokenizer(grammarPath);

    port.on('message', (task: WorkspaceWorkerTask) => {
        void (async () => {
            const results: WorkspaceWorkerFileResult[] = [];
            for (const file of task.files) {
                try {
                    const tokenized = await tokenizer.tokenizeLines(
                        file.text.split(/\r\n|\r|\n/),
                    );
                    results.push({
                        uri: file.uri,
                        records: flattenWorkspaceSymbols(buildOutline(tokenized)),
                    });
                } catch (err) {
                    results.push({
                        uri: file.uri,
                        records: [],
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
            const result: WorkspaceWorkerResult = { id: task.id, results };
            port.postMessage(result);
        })();
    });
}
