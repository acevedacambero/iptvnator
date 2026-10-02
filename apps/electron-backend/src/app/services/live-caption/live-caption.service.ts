import os from 'node:os';
import {
    LiveCaptionStartOptions,
    LiveCaptionState,
    LiveCaptionSupport,
} from '@iptvnator/shared/interfaces';
import { buildAiCaptionAssOverlay } from './ai-caption-ass';
import { extractNovelCaptionText } from './caption-overlap';
import { LiveCaptionCcLineBuffer } from './live-caption-cc-line';
import { resolveLiveCaptionHelperPath } from './live-caption-helper-platform.util';
import { ensureDefaultLiveCaptionModel } from './live-caption-model-manager';
import { liveCaptionMpvOverlayService } from './live-caption-mpv-overlay.service';
import { LiveCaptionPcmWindow } from './live-caption-pcm-window';
import {
    LiveCaptionAudioSourceEvent,
    LiveCaptionProcessAudioSource,
} from './live-caption-process-audio-source';
import { liveCaptionTranslationSettingsStore } from './live-caption-translation-settings.store';
import { LiveCaptionTranslator } from './live-caption-translator';
import { LiveCaptionWhisperClient } from './live-caption-whisper-client';
import {
    resolveLiveCaptionWhisperHelperPath,
    resolveLiveCaptionWhisperModelPath,
} from './live-caption-whisper-platform.util';

const MIN_PROCESS_LOOPBACK_BUILD = 20348;
const MIN_INFERENCE_AUDIO_SECONDS = 1.5;
const EMPTY_WINDOWS_TO_CLEAR = 3;

type StateListener = (state: LiveCaptionState) => void;

interface PendingTranslation {
    sourceText: string;
    revision: number;
}

interface ActiveCaptionSession {
    sessionId: string;
    generation: number;
    audio: LiveCaptionProcessAudioSource;
    whisper: LiveCaptionWhisperClient;
    translator: LiveCaptionTranslator | null;
    window: LiveCaptionPcmWindow;
    ccLine: LiveCaptionCcLineBuffer;
    lastHypothesis: string;
    committedText: string;
    captionRevision: number;
    pendingTranslation: PendingTranslation | null;
    lastTranslatedText: string;
    lastInferenceMs?: number;
    lastTranslationMs?: number;
    translationError?: string;
    emptyWindows: number;
    stopping: boolean;
}

function windowsBuildNumber(): number {
    if (process.platform !== 'win32') {
        return 0;
    }
    const build = Number.parseInt(os.release().split('.')[2] ?? '', 10);
    return Number.isFinite(build) ? build : 0;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Windows V1 live-caption orchestrator.
 *
 * Audio capture, ASR, optional translation and MPV overlay ownership all live
 * in the Electron main process. The renderer can only start/stop the narrow
 * caption pipeline; it never receives MPV's powerful JSON-IPC pipe or raw
 * audio.
 */
export class LiveCaptionService {
    private active: ActiveCaptionSession | null = null;
    private generation = 0;
    private state: LiveCaptionState = {
        state: 'inactive',
        active: false,
        generation: 0,
    };
    private readonly listeners = new Set<StateListener>();

    getSupport(): LiveCaptionSupport {
        const build = windowsBuildNumber();
        const processLoopbackAvailable =
            process.platform === 'win32' && build >= MIN_PROCESS_LOOPBACK_BUILD;
        const captureHelperAvailable = resolveLiveCaptionHelperPath() !== null;
        const whisperHelperAvailable =
            resolveLiveCaptionWhisperHelperPath() !== null;
        const modelConfigured = resolveLiveCaptionWhisperModelPath() !== null;

        let reason: string | undefined;
        if (process.platform !== 'win32') {
            reason = 'AI live captions V1 are available on Windows only.';
        } else if (process.arch !== 'x64') {
            reason = 'AI live captions V1 currently require Windows x64.';
        } else if (!processLoopbackAvailable) {
            reason = `Process loopback audio capture requires Windows build ${MIN_PROCESS_LOOPBACK_BUILD} or newer.`;
        } else if (!captureHelperAvailable) {
            reason = 'The live-caption audio helper is missing from this build.';
        } else if (!whisperHelperAvailable) {
            reason = 'The Whisper live-caption helper is missing from this build.';
        }

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
        return { ...this.state };
    }

    subscribe(listener: StateListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async start(
        sessionId: string,
        options: LiveCaptionStartOptions = {}
    ): Promise<LiveCaptionState> {
        const support = this.getSupport();
        if (!support.supported) {
            throw new Error(support.reason ?? 'AI live captions are unavailable.');
        }
        if (!sessionId.trim()) {
            throw new Error('Embedded MPV session id is required.');
        }

        await this.stop();
        const generation = ++this.generation;
        let translator: LiveCaptionTranslator | null = null;
        let translationError: string | undefined;
        let translationOptions = options.translation;
        if (translationOptions === undefined) {
            try {
                translationOptions =
                    liveCaptionTranslationSettingsStore.resolveForSession();
            } catch (error) {
                translationError = errorMessage(error);
            }
        }
        if (translationOptions?.enabled === true) {
            try {
                translator = new LiveCaptionTranslator(translationOptions);
            } catch (error) {
                // Translation is deliberately optional. A bad provider config
                // must not take source-language live captions down with it.
                translationError = errorMessage(error);
            }
        }
        const active: ActiveCaptionSession = {
            sessionId,
            generation,
            audio: new LiveCaptionProcessAudioSource(),
            whisper: new LiveCaptionWhisperClient(),
            translator,
            window: new LiveCaptionPcmWindow(),
            ccLine: new LiveCaptionCcLineBuffer(),
            lastHypothesis: '',
            committedText: '',
            captionRevision: 0,
            pendingTranslation: null,
            lastTranslatedText: '',
            ...(translationError ? { translationError } : {}),
            emptyWindows: 0,
            stopping: false,
        };
        this.active = active;
        this.publishActive(active, 'starting');

        try {
            const modelPath =
                resolveLiveCaptionWhisperModelPath(options.modelPath) ??
                (await ensureDefaultLiveCaptionModel());
            if (!this.isCurrent(active)) {
                return this.getState();
            }
            await active.whisper.start({
                modelPath,
                threads: options.threads,
            });
            if (!this.isCurrent(active)) {
                return this.getState();
            }
            active.audio.start({
                onPcm: (chunk) => this.onPcm(active, chunk),
                onEvent: (event) => this.onAudioEvent(active, event),
            });
            return this.getState();
        } catch (error) {
            this.fail(active, error);
            throw error;
        }
    }

    async stop(sessionId?: string): Promise<LiveCaptionState> {
        const active = this.active;
        if (!active || (sessionId && active.sessionId !== sessionId)) {
            return this.getState();
        }
        active.stopping = true;
        this.active = null;
        active.audio.stop();
        active.whisper.stop();
        active.translator?.stop();
        active.window.clear();
        active.ccLine.clear();
        active.pendingTranslation = null;
        await liveCaptionMpvOverlayService
            .clearOverlay(active.sessionId)
            .catch(() => undefined);
        this.publish({
            state: 'inactive',
            active: false,
            generation: active.generation,
        });
        return this.getState();
    }

    shutdown(): void {
        void this.stop();
        this.listeners.clear();
    }

    private onAudioEvent(
        active: ActiveCaptionSession,
        event: LiveCaptionAudioSourceEvent
    ): void {
        if (!this.isCurrent(active) || active.stopping) {
            return;
        }
        if (event.type === 'ready') {
            this.publishActive(active, 'running');
            return;
        }
        if (event.type === 'unsupported') {
            this.fail(
                active,
                new Error(
                    `Process loopback audio capture requires Windows build ${event.minimumBuild} or newer (current ${event.build}).`
                )
            );
            return;
        }
        if (event.type === 'error') {
            this.fail(active, new Error(`${event.stage}: ${event.message}`));
            return;
        }
        if (event.type === 'closed') {
            this.fail(
                active,
                new Error('Live-caption audio capture stopped unexpectedly.')
            );
        }
    }

    private onPcm(active: ActiveCaptionSession, chunk: Buffer): void {
        if (!this.isCurrent(active) || active.stopping) {
            return;
        }
        const snapshot = active.window.push(chunk);
        if (
            !snapshot ||
            active.window.bufferedSeconds < MIN_INFERENCE_AUDIO_SECONDS ||
            active.whisper.busy
        ) {
            return;
        }
        void this.transcribeLatest(active, snapshot);
    }

    private async transcribeLatest(
        active: ActiveCaptionSession,
        pcm: Buffer
    ): Promise<void> {
        try {
            const result = await active.whisper.transcribe(pcm);
            if (!this.isCurrent(active) || active.stopping) {
                return;
            }
            active.lastInferenceMs = result.elapsedMs;
            const text = result.text.replace(/\s+/g, ' ').trim();
            if (!text) {
                active.emptyWindows += 1;

                // Finish a short spoken fragment as one stable CC line before
                // eventually clearing the overlay on sustained silence.
                const flushedLine = active.ccLine.flush();
                if (flushedLine) {
                    await this.commitCaptionLine(active, flushedLine);
                    return;
                }

                if (active.emptyWindows >= EMPTY_WINDOWS_TO_CLEAR) {
                    active.lastHypothesis = '';
                    active.committedText = '';
                    active.lastTranslatedText = '';
                    active.pendingTranslation = null;
                    active.captionRevision += 1;
                    active.ccLine.clear();
                    await liveCaptionMpvOverlayService.clearOverlay(
                        active.sessionId
                    );
                    this.publishActive(active, 'running');
                }
                return;
            }

            active.emptyWindows = 0;
            const novel = active.lastHypothesis
                ? extractNovelCaptionText(active.lastHypothesis, text)
                : text;
            active.lastHypothesis = text;
            if (!novel) {
                return;
            }

            // Do not repaint the growing rolling transcript. Accumulate it
            // off-screen and emit exactly one stable television-style CC line
            // at a sentence boundary or word limit.
            const completedLine = active.ccLine.push(novel);
            if (!completedLine) {
                return;
            }
            await this.commitCaptionLine(active, completedLine);
        } catch (error) {
            if (this.isCurrent(active)) {
                this.fail(active, error);
            }
        }
    }

    private async commitCaptionLine(
        active: ActiveCaptionSession,
        sourceText: string
    ): Promise<void> {
        if (!this.isCurrent(active) || active.stopping) {
            return;
        }
        const line = sourceText.replace(/\s+/g, ' ').trim();
        if (!line) {
            return;
        }

        active.committedText = line;
        active.captionRevision += 1;
        active.lastTranslatedText = '';

        // A completed English CC line appears atomically and is never
        // rewritten. Translation targets this stable line, so a normal ASR
        // update no longer invalidates the Chinese result every 500 ms.
        await liveCaptionMpvOverlayService.setOverlay(
            active.sessionId,
            buildAiCaptionAssOverlay({
                sourceText: line,
                mode: 'source-only',
            })
        );
        if (!this.isCurrent(active) || active.stopping) {
            return;
        }
        this.publishActive(active, 'running');
        this.queueTranslation(active, {
            sourceText: line,
            revision: active.captionRevision,
        });
    }

    private queueTranslation(
        active: ActiveCaptionSession,
        request: PendingTranslation
    ): void {
        if (!active.translator || !this.isCurrent(active) || active.stopping) {
            return;
        }
        if (active.translator.busy) {
            // Keep only the newest completed CC line. A translation of a line
            // that has already left the screen is no longer useful.
            active.pendingTranslation = request;
            return;
        }
        active.pendingTranslation = null;
        void this.translateLatest(active, request);
    }

    private async translateLatest(
        active: ActiveCaptionSession,
        request: PendingTranslation
    ): Promise<void> {
        const translator = active.translator;
        if (!translator) {
            return;
        }
        try {
            const result = await translator.translate(request.sourceText);
            if (!this.isTranslationCurrent(active, request)) {
                return;
            }
            active.lastTranslatedText = result.text;
            active.lastTranslationMs = result.elapsedMs;
            active.translationError = undefined;
            await liveCaptionMpvOverlayService.setOverlay(
                active.sessionId,
                buildAiCaptionAssOverlay({
                    sourceText: request.sourceText,
                    translatedText: result.text,
                    mode: 'bilingual',
                })
            );
            if (this.isTranslationCurrent(active, request)) {
                this.publishActive(active, 'running');
            }
        } catch (error) {
            if (this.isTranslationCurrent(active, request)) {
                active.translationError = errorMessage(error);
                active.lastTranslatedText = '';
                this.publishActive(active, 'running');
            }
        } finally {
            if (!this.isCurrent(active) || active.stopping) {
                return;
            }
            const pending = active.pendingTranslation;
            active.pendingTranslation = null;
            if (
                pending &&
                pending.revision === active.captionRevision &&
                pending.sourceText === active.committedText
            ) {
                this.queueTranslation(active, pending);
            }
        }
    }

    private isTranslationCurrent(
        active: ActiveCaptionSession,
        request: PendingTranslation
    ): boolean {
        return (
            this.isCurrent(active) &&
            !active.stopping &&
            active.captionRevision === request.revision &&
            active.committedText === request.sourceText
        );
    }

    private publishActive(
        active: ActiveCaptionSession,
        state: 'starting' | 'running'
    ): void {
        this.publish({
            state,
            active: true,
            sessionId: active.sessionId,
            generation: active.generation,
            ...(active.committedText ? { lastText: active.committedText } : {}),
            ...(active.lastTranslatedText
                ? { lastTranslatedText: active.lastTranslatedText }
                : {}),
            ...(active.lastInferenceMs !== undefined
                ? { lastInferenceMs: active.lastInferenceMs }
                : {}),
            ...(active.lastTranslationMs !== undefined
                ? { lastTranslationMs: active.lastTranslationMs }
                : {}),
            ...(active.translationError
                ? { translationError: active.translationError }
                : {}),
        });
    }

    private fail(active: ActiveCaptionSession, error: unknown): void {
        if (!this.isCurrent(active) || active.stopping) {
            return;
        }
        active.stopping = true;
        this.active = null;
        active.audio.stop();
        active.whisper.stop();
        active.translator?.stop();
        active.ccLine.clear();
        active.pendingTranslation = null;
        void liveCaptionMpvOverlayService
            .clearOverlay(active.sessionId)
            .catch(() => undefined);
        this.publish({
            state: 'error',
            active: false,
            generation: active.generation,
            error: errorMessage(error),
        });
    }

    private isCurrent(active: ActiveCaptionSession): boolean {
        return this.active === active && this.generation === active.generation;
    }

    private publish(state: LiveCaptionState): void {
        this.state = { ...state };
        for (const listener of this.listeners) {
            try {
                listener(this.getState());
            } catch {
                // UI notifications must never break capture/ASR.
            }
        }
    }
}

export const liveCaptionService = new LiveCaptionService();
