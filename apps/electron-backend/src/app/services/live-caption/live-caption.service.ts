import os from 'node:os';
import {
    LiveCaptionStartOptions,
    LiveCaptionState,
    LiveCaptionSupport,
} from '@iptvnator/shared/interfaces';
import { buildAiCaptionAssOverlay } from './ai-caption-ass';
import { extractNovelCaptionText } from './caption-overlap';
import { resolveLiveCaptionHelperPath } from './live-caption-helper-platform.util';
import { liveCaptionMpvOverlayService } from './live-caption-mpv-overlay.service';
import { LiveCaptionPcmWindow } from './live-caption-pcm-window';
import {
    LiveCaptionAudioSourceEvent,
    LiveCaptionProcessAudioSource,
} from './live-caption-process-audio-source';
import { LiveCaptionWhisperClient } from './live-caption-whisper-client';
import {
    resolveLiveCaptionWhisperHelperPath,
    resolveLiveCaptionWhisperModelPath,
} from './live-caption-whisper-platform.util';

const MIN_PROCESS_LOOPBACK_BUILD = 20348;
const MIN_INFERENCE_AUDIO_SECONDS = 1.5;
const EMPTY_WINDOWS_TO_CLEAR = 3;
const DISPLAY_WORD_LIMIT = 26;

type StateListener = (state: LiveCaptionState) => void;

interface ActiveCaptionSession {
    sessionId: string;
    generation: number;
    audio: LiveCaptionProcessAudioSource;
    whisper: LiveCaptionWhisperClient;
    window: LiveCaptionPcmWindow;
    lastHypothesis: string;
    committedText: string;
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

function tailWords(value: string, limit = DISPLAY_WORD_LIMIT): string {
    const words = value.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    return words.slice(Math.max(0, words.length - limit)).join(' ');
}

/**
 * Windows V1 live-caption orchestrator.
 *
 * Audio capture, ASR and MPV overlay ownership all live in the Electron main
 * process. The renderer can only start/stop the narrow caption pipeline; it
 * never receives MPV's powerful JSON-IPC pipe or raw audio.
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
        } else if (!processLoopbackAvailable) {
            reason = `Process loopback audio capture requires Windows build ${MIN_PROCESS_LOOPBACK_BUILD} or newer.`;
        } else if (!captureHelperAvailable) {
            reason = 'The live-caption audio helper is missing from this build.';
        } else if (!whisperHelperAvailable) {
            reason = 'The Whisper live-caption helper is missing from this build.';
        } else if (!modelConfigured) {
            reason =
                'No Whisper model is configured. Install ggml-small.en.bin in the IPTVnator user-data models/whisper directory or set IPTVNATOR_WHISPER_MODEL.';
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
        if (!support.supported && !options.modelPath) {
            throw new Error(support.reason ?? 'AI live captions are unavailable.');
        }
        if (!sessionId.trim()) {
            throw new Error('Embedded MPV session id is required.');
        }

        await this.stop();
        const generation = ++this.generation;
        const active: ActiveCaptionSession = {
            sessionId,
            generation,
            audio: new LiveCaptionProcessAudioSource(),
            whisper: new LiveCaptionWhisperClient(),
            window: new LiveCaptionPcmWindow(),
            lastHypothesis: '',
            committedText: '',
            emptyWindows: 0,
            stopping: false,
        };
        this.active = active;
        this.publish({
            state: 'starting',
            active: true,
            sessionId,
            generation,
        });

        try {
            await active.whisper.start({
                modelPath: options.modelPath,
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
        active.window.clear();
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
            this.publish({
                state: 'running',
                active: true,
                sessionId: active.sessionId,
                generation: active.generation,
            });
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
            this.fail(active, new Error('Live-caption audio capture stopped unexpectedly.'));
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
            const text = result.text.replace(/\s+/g, ' ').trim();
            if (!text) {
                active.emptyWindows += 1;
                if (active.emptyWindows >= EMPTY_WINDOWS_TO_CLEAR) {
                    active.lastHypothesis = '';
                    active.committedText = '';
                    await liveCaptionMpvOverlayService.clearOverlay(
                        active.sessionId
                    );
                    this.publish({
                        state: 'running',
                        active: true,
                        sessionId: active.sessionId,
                        generation: active.generation,
                        lastInferenceMs: result.elapsedMs,
                    });
                }
                return;
            }

            active.emptyWindows = 0;
            if (!active.lastHypothesis) {
                active.committedText = text;
            } else {
                const novel = extractNovelCaptionText(
                    active.lastHypothesis,
                    text
                );
                if (novel) {
                    active.committedText = `${active.committedText} ${novel}`.trim();
                }
            }
            active.lastHypothesis = text;
            active.committedText = tailWords(active.committedText || text);

            const overlay = buildAiCaptionAssOverlay({
                sourceText: active.committedText,
                mode: 'source-only',
            });
            await liveCaptionMpvOverlayService.setOverlay(
                active.sessionId,
                overlay
            );
            if (!this.isCurrent(active)) {
                return;
            }
            this.publish({
                state: 'running',
                active: true,
                sessionId: active.sessionId,
                generation: active.generation,
                lastText: active.committedText,
                lastInferenceMs: result.elapsedMs,
            });
        } catch (error) {
            if (this.isCurrent(active)) {
                this.fail(active, error);
            }
        }
    }

    private fail(active: ActiveCaptionSession, error: unknown): void {
        if (!this.isCurrent(active) || active.stopping) {
            return;
        }
        active.stopping = true;
        this.active = null;
        active.audio.stop();
        active.whisper.stop();
        void liveCaptionMpvOverlayService
            .clearOverlay(active.sessionId)
            .catch(() => undefined);
        this.publish({
            state: 'error',
            active: false,
            generation: active.generation,
            error: error instanceof Error ? error.message : String(error),
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
