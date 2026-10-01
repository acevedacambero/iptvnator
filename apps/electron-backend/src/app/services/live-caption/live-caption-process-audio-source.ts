import { ChildProcessByStdio, spawn } from 'child_process';
import { Readable } from 'stream';
import { resolveLiveCaptionHelperPath } from './live-caption-helper-platform.util';

export interface LiveCaptionPcmFormat {
    sampleRate: number;
    channels: number;
    format: 's16le';
}

export type LiveCaptionAudioSourceEvent =
    | { type: 'ready'; format: LiveCaptionPcmFormat; targetPid: number }
    | { type: 'unsupported'; build: number; minimumBuild: number }
    | { type: 'error'; stage: string; message: string }
    | { type: 'closed'; code: number | null; signal: NodeJS.Signals | null };

export interface LiveCaptionAudioSourceCallbacks {
    onPcm: (chunk: Buffer) => void;
    onEvent?: (event: LiveCaptionAudioSourceEvent) => void;
}

interface HelperStatusMessage {
    event?: string;
    sampleRate?: number;
    channels?: number;
    format?: string;
    targetPid?: number;
    build?: number;
    minimumBuild?: number;
    stage?: string;
    hresult?: string;
    reason?: string;
}

type CaptionHelperProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Starts the Windows process-loopback helper and exposes its stdout as raw
 * 16 kHz mono signed-16 PCM. The helper targets the Electron main process,
 * where Windows native-view libmpv renders audio, and includes its process
 * tree as required by the Windows process-loopback API.
 */
export class LiveCaptionProcessAudioSource {
    private child: CaptionHelperProcess | null = null;
    private stderrBuffer = '';
    private stopping = false;

    get running(): boolean {
        return this.child !== null && this.child.exitCode === null;
    }

    start(callbacks: LiveCaptionAudioSourceCallbacks): void {
        if (this.running) {
            throw new Error('Live-caption audio capture is already running.');
        }
        const helperPath = resolveLiveCaptionHelperPath();
        if (!helperPath) {
            throw new Error(
                'The Windows live-caption audio helper is not available in this build.'
            );
        }

        this.stopping = false;
        this.stderrBuffer = '';
        const child = spawn(helperPath, ['--pid', String(process.pid)], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.child = child;

        child.stdout.on('data', (chunk: Buffer) => {
            if (!this.stopping && chunk.length > 0) {
                callbacks.onPcm(chunk);
            }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            this.consumeStatus(chunk, callbacks);
        });
        child.on('error', (error) => {
            callbacks.onEvent?.({
                type: 'error',
                stage: 'spawn',
                message: error.message,
            });
        });
        child.on('close', (code, signal) => {
            if (this.child === child) {
                this.child = null;
            }
            callbacks.onEvent?.({ type: 'closed', code, signal });
        });
    }

    stop(): void {
        const child = this.child;
        this.child = null;
        this.stopping = true;
        this.stderrBuffer = '';
        if (!child) {
            return;
        }
        child.stdout.destroy();
        child.stderr.destroy();
        if (child.exitCode === null && !child.killed) {
            child.kill();
        }
    }

    private consumeStatus(
        chunk: string,
        callbacks: LiveCaptionAudioSourceCallbacks
    ): void {
        this.stderrBuffer += chunk;
        while (true) {
            const newline = this.stderrBuffer.indexOf('\n');
            if (newline < 0) {
                return;
            }
            const line = this.stderrBuffer.slice(0, newline).trim();
            this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
            if (!line) {
                continue;
            }
            this.emitStatusLine(line, callbacks);
        }
    }

    private emitStatusLine(
        line: string,
        callbacks: LiveCaptionAudioSourceCallbacks
    ): void {
        let message: HelperStatusMessage;
        try {
            message = JSON.parse(line) as HelperStatusMessage;
        } catch {
            callbacks.onEvent?.({
                type: 'error',
                stage: 'helper-status',
                message: line,
            });
            return;
        }

        if (
            message.event === 'ready' &&
            message.format === 's16le' &&
            typeof message.sampleRate === 'number' &&
            typeof message.channels === 'number' &&
            typeof message.targetPid === 'number'
        ) {
            callbacks.onEvent?.({
                type: 'ready',
                format: {
                    sampleRate: message.sampleRate,
                    channels: message.channels,
                    format: 's16le',
                },
                targetPid: message.targetPid,
            });
            return;
        }

        if (
            message.event === 'unsupported' &&
            typeof message.build === 'number' &&
            typeof message.minimumBuild === 'number'
        ) {
            callbacks.onEvent?.({
                type: 'unsupported',
                build: message.build,
                minimumBuild: message.minimumBuild,
            });
            return;
        }

        if (message.event === 'error') {
            callbacks.onEvent?.({
                type: 'error',
                stage: message.stage ?? 'helper',
                message: message.hresult ?? message.reason ?? line,
            });
        }
    }
}
