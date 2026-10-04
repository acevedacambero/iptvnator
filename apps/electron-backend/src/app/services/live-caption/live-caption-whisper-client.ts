import { ChildProcess, spawn } from 'child_process';
import type { LiveCaptionTimedToken } from './live-caption-timeline';
import {
    resolveLiveCaptionWhisperHelperPath,
    resolveLiveCaptionWhisperModelPath,
} from './live-caption-whisper-platform.util';

interface WhisperWorkerReady {
    event: 'ready';
    model: string;
    sampleRate: number;
    threads: number;
}

interface WhisperWorkerReply {
    id: number;
    ok: boolean;
    text?: string;
    elapsedMs?: number;
    error?: string;
    message?: string;
    tokens?: LiveCaptionTimedToken[];
}

export interface LiveCaptionWhisperResult {
    text: string;
    elapsedMs: number;
    tokens?: LiveCaptionTimedToken[];
}

interface PendingInference {
    requestId: number;
    resolve: (value: LiveCaptionWhisperResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

const START_TIMEOUT_MS = 30_000;
const INFERENCE_TIMEOUT_MS = 30_000;
const MAX_PCM_BYTES = 16_000 * 2 * 12;

/**
 * Persistent wrapper around `iptvnator_whisper_helper.exe`.
 *
 * The model is loaded once. Requests are framed as <request-id:uint32 LE,
 * pcm-bytes:uint32 LE, raw s16le mono PCM>. The worker answers with NDJSON.
 * V1 intentionally permits only one inference in flight so a slow CPU cannot
 * turn live captions into an ever-growing queue of stale audio windows.
 */
export class LiveCaptionWhisperClient {
    private child: ChildProcess | null = null;
    private stdoutBuffer = '';
    private stderrBuffer = '';
    private nextRequestId = 1;
    private pending: PendingInference | null = null;
    private readyPromise: Promise<WhisperWorkerReady> | null = null;
    private readyResolve: ((value: WhisperWorkerReady) => void) | null = null;
    private readyReject: ((error: Error) => void) | null = null;

    get running(): boolean {
        return this.child !== null && this.child.exitCode === null;
    }

    get busy(): boolean {
        return this.pending !== null;
    }

    async start(
        options: {
            modelPath?: string;
            threads?: number;
        } = {}
    ): Promise<WhisperWorkerReady> {
        if (this.running && this.readyPromise) {
            return this.readyPromise;
        }
        const helperPath = resolveLiveCaptionWhisperHelperPath();
        if (!helperPath) {
            throw new Error(
                'The Windows whisper live-caption helper is not available in this build.'
            );
        }
        const modelPath = resolveLiveCaptionWhisperModelPath(options.modelPath);
        if (!modelPath) {
            throw new Error(
                'No Whisper model is configured. Set IPTVNATOR_WHISPER_MODEL or place ggml-small.en.bin under the IPTVnator user-data models/whisper directory.'
            );
        }

        this.stop();
        this.stdoutBuffer = '';
        this.stderrBuffer = '';
        const args = ['--model', modelPath];
        if (Number.isFinite(options.threads) && (options.threads ?? 0) > 0) {
            args.push(
                '--threads',
                String(Math.max(1, Math.round(options.threads as number)))
            );
        }
        const child = spawn(helperPath, args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;

        this.readyPromise = new Promise<WhisperWorkerReady>(
            (resolve, reject) => {
                this.readyResolve = resolve;
                this.readyReject = reject;
            }
        );
        const startTimer = setTimeout(() => {
            this.failReady(
                new Error(
                    'Whisper worker did not become ready before the timeout.'
                )
            );
            this.stop();
        }, START_TIMEOUT_MS);
        this.readyPromise
            .finally(() => clearTimeout(startTimer))
            .catch(() => undefined);

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => this.consumeStdout(chunk));
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-8192);
        });
        child.on('error', (error) => {
            this.failReady(error);
            this.failPending(error);
        });
        child.on('close', (code, signal) => {
            const details = this.stderrBuffer.trim();
            const error = new Error(
                `Whisper worker closed (${code ?? 'null'}/${signal ?? 'none'})${
                    details ? `: ${details}` : ''
                }`
            );
            if (this.child === child) {
                this.child = null;
            }
            this.failReady(error);
            this.failPending(error);
        });

        return this.readyPromise;
    }

    async transcribe(pcm: Buffer): Promise<LiveCaptionWhisperResult> {
        if (!this.running || !this.child?.stdin) {
            throw new Error('Whisper worker is not running.');
        }
        if (this.pending) {
            throw new Error('Whisper inference is already in flight.');
        }
        if (
            pcm.length === 0 ||
            pcm.length > MAX_PCM_BYTES ||
            pcm.length % 2 !== 0
        ) {
            throw new Error('Whisper PCM payload size is invalid.');
        }
        const ready = this.readyPromise;
        if (!ready) {
            throw new Error('Whisper worker has not been started.');
        }
        await ready;

        const input = this.child?.stdin;
        if (!input || input.destroyed) throw new Error('Whisper worker stopped.');

        const requestId = this.nextRequestId++ >>> 0;
        const header = Buffer.allocUnsafe(8);
        header.writeUInt32LE(requestId, 0);
        header.writeUInt32LE(pcm.length, 4);

        return new Promise<LiveCaptionWhisperResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending?.requestId === requestId) {
                    this.pending = null;
                }
                reject(new Error('Whisper inference timed out.'));
            }, INFERENCE_TIMEOUT_MS);
            this.pending = { requestId, resolve, reject, timer };
            input.write(Buffer.concat([header, pcm]), (error) => {
                if (error && this.pending?.requestId === requestId) {
                    this.failPending(error);
                }
            });
        });
    }

    stop(): void {
        const child = this.child;
        this.child = null;
        const stopError = new Error('Whisper worker stopped.');
        this.failReady(stopError);
        this.readyPromise = null;
        this.failPending(stopError);
        this.stdoutBuffer = '';
        this.stderrBuffer = '';
        if (!child) {
            return;
        }
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (child.exitCode === null && !child.killed) {
            child.kill();
        }
    }

    private consumeStdout(chunk: string): void {
        this.stdoutBuffer += chunk;
        while (true) {
            const newline = this.stdoutBuffer.indexOf('\n');
            if (newline < 0) {
                return;
            }
            const line = this.stdoutBuffer.slice(0, newline).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            if (!line) {
                continue;
            }
            this.consumeLine(line);
        }
    }

    private consumeLine(line: string): void {
        let message: WhisperWorkerReady | WhisperWorkerReply;
        try {
            message = JSON.parse(line) as
                WhisperWorkerReady | WhisperWorkerReply;
        } catch {
            return;
        }
        if ('event' in message && message.event === 'ready') {
            this.readyResolve?.(message);
            this.readyResolve = null;
            this.readyReject = null;
            return;
        }
        if (!('id' in message) || !this.pending) {
            return;
        }
        if (message.id !== this.pending.requestId) {
            return;
        }
        const pending = this.pending;
        this.pending = null;
        clearTimeout(pending.timer);
        if (!message.ok) {
            pending.reject(
                new Error(
                    message.message ??
                        message.error ??
                        'Whisper worker inference failed.'
                )
            );
            return;
        }
        pending.resolve({
            text: (message.text ?? '').trim(),
            elapsedMs: Math.max(0, Math.round(message.elapsedMs ?? 0)),
            ...(Array.isArray(message.tokens)
                ? { tokens: message.tokens }
                : {}),
        });
    }

    private failReady(error: Error): void {
        this.readyReject?.(error);
        this.readyResolve = null;
        this.readyReject = null;
    }

    private failPending(error: Error): void {
        const pending = this.pending;
        this.pending = null;
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        pending.reject(error);
    }
}
