import { computed, signal } from '@angular/core';
import type {
    LiveCaptionStartOptions,
    LiveCaptionState,
    LiveCaptionSupport,
} from '@iptvnator/shared/interfaces';

interface LiveCaptionRendererApi {
    getSupport: () => Promise<LiveCaptionSupport>;
    getState: () => Promise<LiveCaptionState>;
    start: (
        sessionId: string,
        options?: LiveCaptionStartOptions
    ) => Promise<LiveCaptionState>;
    stop: (sessionId?: string) => Promise<LiveCaptionState>;
    onStateChanged: (callback: (state: LiveCaptionState) => void) => () => void;
}

type CaptionWindow = Window & { liveCaptions?: LiveCaptionRendererApi };

const INACTIVE: LiveCaptionState = {
    state: 'inactive',
    active: false,
    generation: 0,
};

/**
 * Renderer-only state holder for the isolated live-caption preload bridge.
 * The bridge itself is deliberately not part of the broad Electron API: it
 * exists only on desktop builds that registered the caption preload.
 */
export class EmbeddedMpvLiveCaptionController {
    readonly support = signal<LiveCaptionSupport | null>(null);
    readonly state = signal<LiveCaptionState>(INACTIVE);
    readonly bridgeAvailable: boolean;

    readonly active = computed(() => this.state().active);
    readonly starting = computed(
        () =>
            this.state().state === 'starting' ||
            this.state().syncTelemetry?.buffering === true
    );
    readonly available = computed(() => this.support()?.supported === true);
    readonly tooltip = computed(() => {
        const state = this.state();
        if (state.state === 'error' && state.error) {
            return state.error;
        }
        if (state.active) {
            if (state.state === 'suspended')
                return 'AI captions paused — resume playback to continue';
            if (state.state === 'starting') {
                return 'Preparing AI live captions. Click to stop.';
            }
            if (state.syncTelemetry?.buffering)
                return 'Preparing synchronized subtitles; playback is buffering. Click to stop.';
            if (state.translationError) {
                return `AI captions are running in English; translation is unavailable: ${state.translationError}`;
            }
            return state.lastTranslatedText
                ? 'Stop AI bilingual live captions'
                : 'Stop AI live captions';
        }
        const support = this.support();
        if (support && !support.supported) {
            return support.reason ?? 'AI live captions are unavailable.';
        }
        return 'AI live captions';
    });

    private readonly api?: LiveCaptionRendererApi;
    private unsubscribe: (() => void) | null = null;
    private disposed = false;
    private commandRevision = 0;

    constructor() {
        this.api =
            typeof window === 'undefined'
                ? undefined
                : (window as CaptionWindow).liveCaptions;
        this.bridgeAvailable = Boolean(this.api);
        if (!this.api) {
            return;
        }
        this.unsubscribe = this.api.onStateChanged((state) => {
            if (!this.disposed) {
                this.state.set(state);
            }
        });
        void this.refresh();
    }

    async toggle(sessionId: string | null): Promise<void> {
        const api = this.api;
        if (!api || !sessionId) {
            return;
        }
        const revision = ++this.commandRevision;
        try {
            const stopping = this.active();
            if (!stopping)
                this.state.set({
                    state: 'starting',
                    active: true,
                    sessionId,
                    generation: this.state().generation,
                });
            const next = stopping
                ? await api.stop(sessionId)
                : await api.start(sessionId);
            if (!this.disposed && revision === this.commandRevision) {
                this.state.set(next);
            }
        } catch (error) {
            if (!this.disposed && revision === this.commandRevision) {
                this.state.set({
                    state: 'error',
                    active: false,
                    generation: this.state().generation,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    dispose(): void {
        this.disposed = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    private async refresh(): Promise<void> {
        const api = this.api;
        if (!api) {
            return;
        }
        try {
            const [support, state] = await Promise.all([
                api.getSupport(),
                api.getState(),
            ]);
            if (this.disposed) {
                return;
            }
            this.support.set(support);
            this.state.set(state);
        } catch (error) {
            if (!this.disposed) {
                this.support.set({
                    supported: false,
                    platform: 'unknown',
                    reason:
                        error instanceof Error ? error.message : String(error),
                    processLoopbackAvailable: false,
                    captureHelperAvailable: false,
                    whisperHelperAvailable: false,
                    modelConfigured: false,
                });
            }
        }
    }
}
