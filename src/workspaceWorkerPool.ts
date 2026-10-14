import * as fs from 'fs';
import * as os from 'os';
import { Worker } from 'worker_threads';
import type {
    WorkspaceWorkerFileInput,
    WorkspaceWorkerFileResult,
    WorkspaceWorkerResult,
} from './workspaceWorker';

/**
 * A small lazy worker pool for workspace indexing.
 *
 * Workers are created only when the first batch is submitted (never at
 * extension activation), reused for subsequent batches, and capped so a
 * many-core machine does not load dozens of Oniguruma WASM instances. If a
 * worker cannot start or dies mid-batch, the batch promise rejects and the
 * caller falls back to main-thread indexing — multithreading is an
 * optimization, never a correctness requirement.
 */

export function defaultWorkspaceWorkerCount(): number {
    const cpus =
        typeof os.availableParallelism === 'function'
            ? os.availableParallelism()
            : os.cpus().length;
    return Math.max(1, Math.min(8, cpus > 1 ? cpus - 1 : 1));
}

interface PendingJob {
    files: WorkspaceWorkerFileInput[];
    resolve: (results: WorkspaceWorkerFileResult[]) => void;
    reject: (err: Error) => void;
}

interface WorkerState {
    worker: Worker;
    busy: boolean;
    job?: PendingJob & { id: number };
}

export class WorkspaceWorkerPool {
    private states: WorkerState[] = [];
    private queue: PendingJob[] = [];
    private nextId = 1;
    private disposed = false;

    constructor(
        private readonly workerScriptPath: string,
        private readonly grammarPath: string,
        readonly size: number,
        private readonly log: (message: string) => void = () => undefined,
    ) {}

    /** Submit one batch of files; resolves with per-file records (or per-file errors). */
    run(files: WorkspaceWorkerFileInput[]): Promise<WorkspaceWorkerFileResult[]> {
        if (this.disposed) {
            return Promise.reject(new Error('Workspace worker pool is disposed.'));
        }
        if (files.length === 0) {
            return Promise.resolve([]);
        }
        if (!fs.existsSync(this.workerScriptPath)) {
            return Promise.reject(
                new Error(`Workspace worker script not found: ${this.workerScriptPath}`),
            );
        }
        return new Promise<WorkspaceWorkerFileResult[]>((resolve, reject) => {
            this.queue.push({ files, resolve, reject });
            this.pump();
        });
    }

    private pump(): void {
        while (this.queue.length > 0) {
            let state = this.states.find((s) => !s.busy);
            if (!state) {
                if (this.states.length >= this.size) {
                    return;
                }
                try {
                    state = this.createState();
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    this.log(`[jai] Failed to start workspace index worker: ${error.message}`);
                    for (const job of this.queue.splice(0)) {
                        job.reject(error);
                    }
                    return;
                }
            }
            const job = this.queue.shift()!;
            const id = this.nextId++;
            state.busy = true;
            state.job = { ...job, id };
            state.worker.postMessage({ id, files: job.files });
        }
    }

    private createState(): WorkerState {
        const worker = new Worker(this.workerScriptPath, {
            workerData: { grammarPath: this.grammarPath },
        });
        const state: WorkerState = { worker, busy: false };
        worker.on('message', (result: WorkspaceWorkerResult) => {
            const job = state.job;
            state.job = undefined;
            state.busy = false;
            if (job) {
                if (result.id === job.id) {
                    job.resolve(result.results);
                } else {
                    job.reject(
                        new Error(`Workspace worker replied with wrong task id ${result.id}.`),
                    );
                }
            }
            this.pump();
        });
        worker.on('error', (err) => this.failState(state, err));
        worker.on('exit', (code) => {
            if (!this.disposed && code !== 0) {
                this.failState(state, new Error(`Workspace index worker exited (${code}).`));
            }
        });
        this.states.push(state);
        return state;
    }

    private failState(state: WorkerState, err: Error): void {
        this.states = this.states.filter((s) => s !== state);
        const job = state.job;
        state.job = undefined;
        state.busy = false;
        if (job) {
            job.reject(err);
        }
        if (!this.disposed) {
            this.pump();
        }
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        const error = new Error('Workspace worker pool is disposed.');
        for (const job of this.queue.splice(0)) {
            job.reject(error);
        }
        const states = this.states;
        this.states = [];
        // Reject in-flight batches too: callers can then fall back to
        // main-thread indexing instead of awaiting a dead worker forever.
        for (const state of states) {
            if (state.job) {
                state.job.reject(error);
                state.job = undefined;
            }
        }
        await Promise.all(states.map((s) => s.worker.terminate().catch(() => 0)));
    }
}
