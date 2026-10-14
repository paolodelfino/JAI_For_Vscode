import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import type { JaiTokenizer } from './tokenizer';
import { buildOutline, type OutlineKindName, type OutlineVisibility } from './outline';
import {
    flattenWorkspaceSymbols,
    matchesWorkspaceSymbolQuery,
    type WorkspaceSymbolRecord,
} from './workspaceSymbolCore';
import {
    WorkspaceWorkerPool,
    defaultWorkspaceWorkerCount,
} from './workspaceWorkerPool';
import type {
    WorkspaceWorkerFileInput,
    WorkspaceWorkerFileResult,
} from './workspaceWorker';

/**
 * Workspace-wide symbol index backing Ctrl+T ("Go to Symbol in Workspace").
 *
 * Design constraints (see README):
 * - Lazy: nothing is scanned, read, or threaded at activation; the index is
 *   built on the first workspace-symbol request and shared by later ones.
 * - Incremental: file watcher + open-document events re-index single files;
 *   a query never rescans the workspace.
 * - Flat: only WorkspaceSymbolRecords (and prebuilt SymbolInformation
 *   objects) are retained — token streams and outline trees are dropped.
 * - Multithreaded when worthwhile: batches go to a small worker pool
 *   (tokenizer + outline off the extension-host main thread), with a
 *   main-thread fallback if workers cannot start. Small batches stay on the
 *   main thread, where worker startup would cost more than the work.
 */

const KIND_MAP: Record<OutlineKindName, vscode.SymbolKind> = {
    Function: vscode.SymbolKind.Function,
    Operator: vscode.SymbolKind.Operator,
    Struct: vscode.SymbolKind.Struct,
    Enum: vscode.SymbolKind.Enum,
    EnumMember: vscode.SymbolKind.EnumMember,
    Field: vscode.SymbolKind.Field,
    Constant: vscode.SymbolKind.Constant,
    Variable: vscode.SymbolKind.Variable,
    TypeParameter: vscode.SymbolKind.TypeParameter,
    Interface: vscode.SymbolKind.Interface,
};

const MAX_FILES = 10000;
const BATCH_MAX_FILES = 16;
const BATCH_MAX_CHARS = 128 * 1024;
const WORKER_MIN_CHARS = 32 * 1024;
const EDIT_DEBOUNCE_MS = 250;

interface WorkspaceSettings {
    enabled: boolean;
    maxWorkers: number;
    maxFileSizeBytes: number;
    exclude: string[];
}

interface IndexedSymbol {
    lowerName: string;
    symbol: vscode.SymbolInformation;
}

export interface WorkspaceSymbolIndexOptions {
    grammarPath: string;
    workerScriptPath: string;
    tokenizer: JaiTokenizer;
    getVisibility: (uri: vscode.Uri) => OutlineVisibility;
    log: (message: string) => void;
}

function splitLines(text: string): string[] {
    return text.split(/\r\n|\r|\n/);
}

export class WorkspaceSymbolIndex implements vscode.Disposable {
    private recordsByUri = new Map<string, WorkspaceSymbolRecord[]>();
    private symbolsByUri = new Map<string, IndexedSymbol[]>();
    private knownDiskUris = new Set<string>();
    private pendingDiskUris = new Set<string>();
    private pendingOpenUris = new Set<string>();
    private pendingRemovals = new Set<string>();
    private editTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private indexingPromise: Promise<void> | undefined;
    private indexComplete = false;
    /** Bumped on every reset so stale in-flight indexing results are dropped. */
    private indexGeneration = 0;
    private pool: WorkspaceWorkerPool | undefined;
    private poolFailed = false;
    private usedWorkers = false;
    private disposed = false;

    constructor(private readonly options: WorkspaceSymbolIndexOptions) {}

    // -- configuration -------------------------------------------------------

    private readSettings(scope?: vscode.Uri): WorkspaceSettings {
        const cfg = vscode.workspace.getConfiguration('jai', scope ?? null);
        const rawWorkers = cfg.get<number>('workspaceSymbols.maxWorkers', 0);
        const maxWorkers =
            Number.isFinite(rawWorkers) && rawWorkers > 0
                ? Math.min(32, Math.floor(rawWorkers))
                : defaultWorkspaceWorkerCount();
        // 0 (the default) means unlimited: no file is skipped for size.
        const rawSizeKiB = cfg.get<number>('workspaceSymbols.maxFileSizeKiB', 0);
        const maxFileSizeBytes =
            Number.isFinite(rawSizeKiB) && rawSizeKiB > 0
                ? rawSizeKiB * 1024
                : Number.POSITIVE_INFINITY;
        // Empty by default: no extension-level exclusions at all.
        const rawExclude = cfg.get<string[]>('workspaceSymbols.exclude', []);
        const exclude = Array.isArray(rawExclude)
            ? rawExclude.filter((p) => typeof p === 'string' && p.length > 0)
            : [];
        return {
            enabled: cfg.get<boolean>('workspaceSymbols.enabled', true) !== false,
            maxWorkers,
            maxFileSizeBytes,
            exclude,
        };
    }

    /** Build the findFiles exclude argument; `null` means no excludes at all. */
    private excludeGlobFor(settings: WorkspaceSettings): string | null {
        if (settings.exclude.length === 0) {
            return null;
        }
        return settings.exclude.length === 1
            ? settings.exclude[0]
            : `{${settings.exclude.join(',')}}`;
    }

    /** Rebuild the visible SymbolInformation objects after outline settings change. */
    refreshVisibility(): void {
        for (const uri of this.recordsByUri.keys()) {
            this.rebuildSymbolsFor(uri);
        }
    }

    /** Workspace-symbol settings changed: forget the scan shape, stay lazy. */
    handleWorkspaceSettingsChanged(): void {
        this.resetIndex();
        if (this.pool) {
            void this.pool.dispose();
            this.pool = undefined;
            this.poolFailed = false;
        }
    }

    private resetIndex(): void {
        this.indexGeneration++;
        this.recordsByUri.clear();
        this.symbolsByUri.clear();
        this.knownDiskUris.clear();
        this.pendingDiskUris.clear();
        this.pendingOpenUris.clear();
        this.pendingRemovals.clear();
        this.indexComplete = false;
    }

    // -- provider entry point --------------------------------------------------

    async provideWorkspaceSymbols(
        query: string,
        token: vscode.CancellationToken,
    ): Promise<vscode.SymbolInformation[]> {
        if (this.disposed || !this.readSettings().enabled) {
            return [];
        }
        try {
            await this.ensureIndexed();
        } catch (err) {
            this.options.log(`[jai] Workspace symbol indexing failed: ${String(err)}`);
        }
        if (token.isCancellationRequested) {
            return [];
        }
        const out: vscode.SymbolInformation[] = [];
        for (const symbols of this.symbolsByUri.values()) {
            for (const indexed of symbols) {
                if (matchesWorkspaceSymbolQuery(indexed.lowerName, query)) {
                    out.push(indexed.symbol);
                }
            }
        }
        return out;
    }

    // -- indexing ----------------------------------------------------------------

    private ensureIndexed(): Promise<void> {
        if (this.indexComplete && !this.indexingPromise) {
            return Promise.resolve();
        }
        if (!this.indexingPromise) {
            this.indexingPromise = this.buildIndex()
                .catch((err) => {
                    this.options.log(`[jai] Workspace symbol indexing failed: ${String(err)}`);
                })
                .finally(() => {
                    this.indexingPromise = undefined;
                });
        }
        return this.indexingPromise;
    }

    private async buildIndex(): Promise<void> {
        const settings = this.readSettings();
        const generation = this.indexGeneration;
        const started = Date.now();
        this.indexComplete = false;

        const openDocs = vscode.workspace.textDocuments.filter((d) => this.isJaiDocument(d));
        const openByUri = new Map(openDocs.map((d) => [d.uri.toString(), d]));

        // Open documents first: they are the most likely search targets, and
        // their in-memory text wins over whatever is on disk.
        await this.processInputs(
            openDocs.map((d) => ({ uri: d.uri.toString(), text: d.getText() })),
            settings,
        );

        // Search every folder open in this VS Code window. In VS Code's
        // model those are exactly `workspaceFolders`: a folder opened with
        // File > Open Folder / Add Folder to Workspace is a workspace
        // folder whether or not it was ever saved as a `.code-workspace`
        // file. Enumerating them explicitly (instead of one global pattern)
        // makes the multi-root behaviour obvious and lets each folder use
        // its own resource-scoped exclude setting. An empty exclude list
        // passes `null`, which disables even VS Code's default
        // `files.exclude` filtering: nothing is excluded.
        // Only when *no* folder is open at all (a window holding loose
        // files) is there no folder tree to search; then the index consists
        // of the open documents indexed above.
        const folders = vscode.workspace.workspaceFolders ?? [];
        const foundByUri = new Map<string, vscode.Uri>();
        for (const folder of folders) {
            const folderExclude = this.excludeGlobFor(this.readSettings(folder.uri));
            const folderFiles = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, '**/*.jai'),
                folderExclude,
                MAX_FILES,
            );
            for (const uri of folderFiles) {
                foundByUri.set(uri.toString(), uri);
            }
        }
        const found = [...foundByUri.values()];
        if (found.length >= MAX_FILES) {
            this.options.log(
                `[jai] Workspace symbol index: stopped at ${MAX_FILES} files; narrow jai.workspaceSymbols.exclude if this workspace has more Jai sources.`,
            );
        }
        this.knownDiskUris = new Set(found.map((u) => u.toString()));
        const diskUris = found
            .map((u) => u.toString())
            .filter((uri) => !openByUri.has(uri))
            .sort();
        await this.processDiskUris(diskUris, settings, openByUri);

        // Anything that changed while we were scanning gets one more pass.
        while (
            this.pendingDiskUris.size > 0 ||
            this.pendingOpenUris.size > 0 ||
            this.pendingRemovals.size > 0
        ) {
            const removals = [...this.pendingRemovals];
            this.pendingRemovals.clear();
            for (const uri of removals) {
                if (!this.knownDiskUris.has(uri)) {
                    this.removeUri(uri);
                }
            }
            const openUris = [...this.pendingOpenUris];
            this.pendingOpenUris.clear();
            for (const uri of openUris) {
                const doc = vscode.workspace.textDocuments.find(
                    (d) => d.uri.toString() === uri && this.isJaiDocument(d),
                );
                if (doc) {
                    await this.processInputs(
                        [{ uri, text: doc.getText() }],
                        this.readSettings(),
                    );
                }
            }
            const disk = [...this.pendingDiskUris].filter(
                (uri) => !vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri),
            );
            this.pendingDiskUris.clear();
            if (disk.length > 0) {
                await this.processDiskUris(disk, this.readSettings(), openByUri);
            }
        }

        if (generation !== this.indexGeneration) {
            return; // reset while scanning; stay lazy and rebuild on demand
        }
        this.indexComplete = true;
        let symbolCount = 0;
        for (const records of this.recordsByUri.values()) {
            symbolCount += records.length;
        }
        this.options.log(
            `[jai] Workspace symbol index: ${this.recordsByUri.size} files, ${symbolCount} symbols in ${Date.now() - started} ms (${this.usedWorkers ? 'worker threads' : 'main thread'}).`,
        );
    }

    private async processDiskUris(
        uriStrings: string[],
        settings: WorkspaceSettings,
        openByUri: Map<string, vscode.TextDocument>,
    ): Promise<void> {
        const decoder = new TextDecoder('utf-8');
        let batch: WorkspaceWorkerFileInput[] = [];
        let batchChars = 0;
        const jobs: Promise<void>[] = [];
        const maxParallelJobs = Math.max(1, settings.maxWorkers * 2);

        const dispatch = async (): Promise<void> => {
            if (batch.length === 0) {
                return;
            }
            const current = batch;
            batch = [];
            batchChars = 0;
            const job = this.processInputs(current, settings);
            jobs.push(job);
            if (jobs.length >= maxParallelJobs) {
                // Process in bounded groups: the backlog (and thus the amount
                // of source text held in memory) stays proportional to the
                // worker count, and every job is awaited before we finish.
                await Promise.all(jobs);
                jobs.length = 0;
            }
        };

        for (const uriString of uriStrings) {
            if (this.disposed) {
                return;
            }
            if (openByUri.has(uriString)) {
                continue;
            }
            const uri = vscode.Uri.parse(uriString);
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type !== vscode.FileType.File) {
                    continue;
                }
                if (stat.size > settings.maxFileSizeBytes) {
                    this.setRecords(uriString, []);
                    continue;
                }
                const bytes = await vscode.workspace.fs.readFile(uri);
                const text = decoder.decode(bytes);
                batch.push({ uri: uriString, text });
                batchChars += text.length;
                if (batch.length >= BATCH_MAX_FILES || batchChars >= BATCH_MAX_CHARS) {
                    await dispatch();
                }
            } catch {
                // Unreadable/vanished file: index it as empty rather than failing the scan.
                this.setRecords(uriString, []);
            }
        }
        await dispatch();
        await Promise.all(jobs);
    }

    private async processInputs(
        inputs: WorkspaceWorkerFileInput[],
        settings: WorkspaceSettings,
    ): Promise<void> {
        if (inputs.length === 0) {
            return;
        }
        const generation = this.indexGeneration;
        const eligible = inputs.filter((input) => {
            if (input.text.length > settings.maxFileSizeBytes) {
                this.setRecords(input.uri, []);
                return false;
            }
            return true;
        });
        if (eligible.length === 0) {
            return;
        }
        const totalChars = eligible.reduce((sum, f) => sum + f.text.length, 0);
        let results: WorkspaceWorkerFileResult[];
        if (!this.poolFailed && totalChars >= WORKER_MIN_CHARS) {
            try {
                results = await this.getPool(settings).run(eligible);
                this.usedWorkers = true;
            } catch (err) {
                this.poolFailed = true;
                this.options.log(
                    `[jai] Workspace index workers unavailable (${err instanceof Error ? err.message : String(err)}); falling back to the main thread.`,
                );
                results = await this.processOnMainThread(eligible);
            }
        } else {
            results = await this.processOnMainThread(eligible);
        }
        if (generation !== this.indexGeneration) {
            return; // index was reset while this batch was in flight
        }
        for (const result of results) {
            if (result.error) {
                this.options.log(
                    `[jai] Workspace index: failed to index ${result.uri}: ${result.error}`,
                );
            }
            this.setRecords(result.uri, result.records);
        }
    }

    private async processOnMainThread(
        inputs: WorkspaceWorkerFileInput[],
    ): Promise<WorkspaceWorkerFileResult[]> {
        const results: WorkspaceWorkerFileResult[] = [];
        for (const input of inputs) {
            try {
                const tokenized = await this.options.tokenizer.tokenizeLines(
                    splitLines(input.text),
                );
                results.push({
                    uri: input.uri,
                    records: flattenWorkspaceSymbols(buildOutline(tokenized)),
                });
            } catch (err) {
                results.push({
                    uri: input.uri,
                    records: [],
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return results;
    }

    private getPool(settings: WorkspaceSettings): WorkspaceWorkerPool {
        if (this.pool && this.pool.size !== settings.maxWorkers) {
            void this.pool.dispose();
            this.pool = undefined;
        }
        if (!this.pool) {
            this.pool = new WorkspaceWorkerPool(
                this.options.workerScriptPath,
                this.options.grammarPath,
                settings.maxWorkers,
                this.options.log,
            );
        }
        return this.pool;
    }

    // -- record storage ------------------------------------------------------------

    private setRecords(uriString: string, records: WorkspaceSymbolRecord[]): void {
        this.recordsByUri.set(uriString, records);
        this.rebuildSymbolsFor(uriString);
    }

    private rebuildSymbolsFor(uriString: string): void {
        const records = this.recordsByUri.get(uriString) ?? [];
        const uri = vscode.Uri.parse(uriString);
        const visibility = this.options.getVisibility(uri);
        const indexed: IndexedSymbol[] = [];
        for (const record of records) {
            if (visibility[record.category] === false) {
                continue;
            }
            indexed.push({
                lowerName: record.name.toLowerCase(),
                symbol: new vscode.SymbolInformation(
                    record.name,
                    KIND_MAP[record.kind],
                    record.containerName,
                    new vscode.Location(
                        uri,
                        new vscode.Range(
                            record.selectionRange.start.line,
                            record.selectionRange.start.character,
                            record.selectionRange.end.line,
                            record.selectionRange.end.character,
                        ),
                    ),
                ),
            });
        }
        this.symbolsByUri.set(uriString, indexed);
    }

    private removeUri(uriString: string): void {
        this.recordsByUri.delete(uriString);
        this.symbolsByUri.delete(uriString);
    }

    // -- events ----------------------------------------------------------------------

    private isJaiDocument(doc: vscode.TextDocument): boolean {
        return (
            doc.languageId === 'jai' &&
            (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled')
        );
    }

    private queueDisk(uriString: string): void {
        if (!this.indexComplete) {
            this.pendingDiskUris.add(uriString);
            return;
        }
        void this.processDiskUris([uriString], this.readSettings(), new Map()).catch((err) =>
            this.options.log(`[jai] Workspace re-index failed for ${uriString}: ${String(err)}`),
        );
    }

    private async indexOpenDocument(doc: vscode.TextDocument): Promise<void> {
        await this.processInputs(
            [{ uri: doc.uri.toString(), text: doc.getText() }],
            this.readSettings(),
        );
    }

    registerEventHandlers(): vscode.Disposable[] {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.jai');
        return [
            watcher,
            watcher.onDidCreate((uri) => {
                this.knownDiskUris.add(uri.toString());
                this.queueDisk(uri.toString());
            }),
            watcher.onDidChange((uri) => {
                const uriString = uri.toString();
                if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === uriString)) {
                    return; // open-document events cover the in-memory text
                }
                this.queueDisk(uriString);
            }),
            watcher.onDidDelete((uri) => {
                const uriString = uri.toString();
                this.knownDiskUris.delete(uriString);
                if (this.indexComplete) {
                    this.removeUri(uriString);
                } else {
                    this.pendingRemovals.add(uriString);
                }
            }),
            vscode.workspace.onDidOpenTextDocument((doc) => {
                if (!this.isJaiDocument(doc)) {
                    return;
                }
                if (this.indexComplete) {
                    void this.indexOpenDocument(doc);
                } else {
                    this.pendingOpenUris.add(doc.uri.toString());
                }
            }),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (!this.isJaiDocument(e.document)) {
                    return;
                }
                const uriString = e.document.uri.toString();
                if (!this.indexComplete) {
                    this.pendingOpenUris.add(uriString);
                    return;
                }
                const existing = this.editTimers.get(uriString);
                if (existing) {
                    clearTimeout(existing);
                }
                this.editTimers.set(
                    uriString,
                    setTimeout(() => {
                        this.editTimers.delete(uriString);
                        if (!this.disposed) {
                            void this.indexOpenDocument(e.document);
                        }
                    }, EDIT_DEBOUNCE_MS),
                );
            }),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (!this.isJaiDocument(doc) || !this.indexComplete) {
                    return;
                }
                const timer = this.editTimers.get(doc.uri.toString());
                if (timer) {
                    clearTimeout(timer);
                    this.editTimers.delete(doc.uri.toString());
                }
                void this.indexOpenDocument(doc);
            }),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                if (!this.isJaiDocument(doc)) {
                    return;
                }
                const uriString = doc.uri.toString();
                const timer = this.editTimers.get(uriString);
                if (timer) {
                    clearTimeout(timer);
                    this.editTimers.delete(uriString);
                }
                if (this.knownDiskUris.has(uriString)) {
                    this.queueDisk(uriString);
                } else if (this.indexComplete) {
                    this.removeUri(uriString);
                } else {
                    this.pendingRemovals.add(uriString);
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.resetIndex();
            }),
        ];
    }

    dispose(): void {
        this.disposed = true;
        for (const timer of this.editTimers.values()) {
            clearTimeout(timer);
        }
        this.editTimers.clear();
        if (this.pool) {
            void this.pool.dispose();
            this.pool = undefined;
        }
    }
}
