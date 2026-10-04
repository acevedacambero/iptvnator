import os from 'node:os';
import type {
    LiveCaptionStartOptions,
    LiveCaptionState,
    LiveCaptionSupport,
} from '@iptvnator/shared/interfaces';
import { LiveCaptionLifecycle } from './live-caption-lifecycle';
import { resolveLiveCaptionHelperPath } from './live-caption-helper-platform.util';
import { ensureDefaultLiveCaptionModel } from './live-caption-model-manager';
import { LiveCaptionSynchronizedSession } from './live-caption-synchronized-session';
import { liveCaptionRecordingExporter } from './live-caption-recording-exporter';
import {
    resolveLiveCaptionWhisperHelperPath,
    resolveLiveCaptionWhisperModelPath,
} from './live-caption-whisper-platform.util';

interface ActiveCaptionSession {
    sessionId: string;
    generation: number;
    pipeline: LiveCaptionSynchronizedSession;
}

/** Main-process ownership: the renderer receives neither raw audio nor MPV IPC. */
export class LiveCaptionService {
    private active: ActiveCaptionSession | null = null;
    private generation = 0;
    private requestVersion = 0;
    private requestedSessionId: string | null = null;
    private state: LiveCaptionState = {
        state: 'inactive',
        active: false,
        generation: 0,
    };
    private readonly listeners = new Set<(state: LiveCaptionState) => void>();
    private readonly unsubscribeExport: () => void;

    constructor() {
        this.unsubscribeExport = liveCaptionRecordingExporter.subscribe(
            (recordingSubtitle) => this.publish({ ...this.state, recordingSubtitle })
        );
    }

    getSupport(): LiveCaptionSupport {
        const processLoopbackAvailable =
            process.platform === 'win32' &&
            Number(os.release().split('.')[2]) >= 20348;
        const captureHelperAvailable = resolveLiveCaptionHelperPath() !== null;
        const whisperHelperAvailable =
            resolveLiveCaptionWhisperHelperPath() !== null;
        const modelConfigured = resolveLiveCaptionWhisperModelPath() !== null;
        const reason =
            process.platform !== 'win32' || process.arch !== 'x64'
                ? 'Synchronized AI live captions currently require Windows x64.'
                : !captureHelperAvailable
                  ? 'The live-caption audio helper is missing from this build.'
                  : !whisperHelperAvailable
                    ? 'The Whisper live-caption helper is missing from this build.'
                    : undefined;
        return {
            supported: reason === undefined,
            platform: process.platform,
            ...(reason ? { reason } : {}),
            processLoopbackAvailable,
            captureHelperAvailable,
            whisperHelperAvailable,
            modelConfigured,
        };
    }
    getState(): LiveCaptionState {
        const recordingSubtitle = liveCaptionRecordingExporter.snapshot();
        return { ...this.state, ...(recordingSubtitle ? { recordingSubtitle } : {}) };
    }
    subscribe(listener: (state: LiveCaptionState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async refreshDisplayStyle(): Promise<void> {
        await this.active?.pipeline.redraw();
    }
    setUserPaused(paused: boolean): void {
        this.active?.pipeline.setUserPaused(paused);
    }

    async start(
        sessionId: string,
        options: LiveCaptionStartOptions = {}
    ): Promise<LiveCaptionState> {
        const support = this.getSupport();
        if (!support.supported) throw new Error(support.reason);
        if (!sessionId.trim())
            throw new Error('Embedded MPV session id is required.');
        const version = ++this.requestVersion;
        this.requestedSessionId = sessionId;
        await this.stopCurrent();
        if (version !== this.requestVersion) return this.getState();
        const generation = ++this.generation;
        const active: ActiveCaptionSession = {
            sessionId,
            generation,
            pipeline: new LiveCaptionSynchronizedSession(
                sessionId,
                () => this.active === active,
                () => this.publishActive(active, 'running'),
                (error) => void this.fail(active, error)
            ),
        };
        this.active = active;
        this.publishActive(active, 'starting');
        try {
            const explicit =
                options.modelPath ?? process.env.IPTVNATOR_WHISPER_MODEL;
            const modelPath = explicit
                ? resolveLiveCaptionWhisperModelPath(explicit)
                : await ensureDefaultLiveCaptionModel();
            if (!modelPath)
                throw new Error('The configured Whisper model is unavailable.');
            if (this.active !== active) return this.getState();
            liveCaptionRecordingExporter.configure(sessionId, modelPath, options);
            await active.pipeline.start(modelPath, options);
            return this.getState();
        } catch (error) {
            if (this.active !== active) return this.getState();
            await this.fail(active, error);
            throw error;
        }
    }
    async stop(sessionId?: string): Promise<LiveCaptionState> {
        if (!sessionId || this.requestedSessionId === sessionId)
            this.requestVersion++;
        return this.stopCurrent(sessionId);
    }
    private async stopCurrent(sessionId?: string): Promise<LiveCaptionState> {
        const active = this.active;
        if (!active || (sessionId && active.sessionId !== sessionId))
            return this.getState();
        liveCaptionRecordingExporter.forget(active.sessionId);
        this.active = null;
        await active.pipeline.stop();
        if (this.active === null)
            this.publish({
                state: 'inactive',
                active: false,
                generation: active.generation,
            });
        return this.getState();
    }
    shutdown(): void {
        this.unsubscribeExport();
        liveCaptionRecordingExporter.shutdown();
        void this.stop();
        this.listeners.clear();
    }
    private publishActive(
        active: ActiveCaptionSession,
        state: 'starting' | 'running'
    ): void {
        if (this.active !== active) return;
        this.publish({
            state,
            active: true,
            sessionId: active.sessionId,
            generation: active.generation,
            ...active.pipeline.snapshot(),
        });
    }
    private async fail(
        active: ActiveCaptionSession,
        error: unknown
    ): Promise<void> {
        if (this.active !== active) return;
        this.active = null;
        liveCaptionRecordingExporter.forget(active.sessionId);
        await active.pipeline.stop();
        if (this.active !== null) return;
        this.publish({
            state: 'error',
            active: false,
            generation: active.generation,
            error: error instanceof Error ? error.message : String(error),
        });
    }
    private publish(state: LiveCaptionState): void {
        this.state = state;
        for (const listener of this.listeners) {
            try {
                listener(this.getState());
            } catch {
                /* UI listeners cannot stop playback. */
            }
        }
    }
}

export const liveCaptionService = new LiveCaptionLifecycle(
    new LiveCaptionService()
);
