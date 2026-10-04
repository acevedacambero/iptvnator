import type {
    LiveCaptionStartOptions,
    LiveCaptionState,
    LiveCaptionSupport,
} from '@iptvnator/shared/interfaces';

interface CaptionPipeline {
    getSupport(): LiveCaptionSupport;
    getState(): LiveCaptionState;
    subscribe(listener: (state: LiveCaptionState) => void): () => void;
    start(
        sessionId: string,
        options?: LiveCaptionStartOptions
    ): Promise<LiveCaptionState>;
    stop(sessionId?: string): Promise<LiveCaptionState>;
    shutdown(): void;
    refreshDisplayStyle?(): Promise<void>;
    setUserPaused?(paused: boolean): void;
}

/** Retains the user's caption intent while playback pauses or replaces media. */
export class LiveCaptionLifecycle {
    private intent: {
        sessionId: string;
        options?: LiveCaptionStartOptions;
    } | null = null;
    private paused = false;
    private revision = 0;

    constructor(private readonly pipeline: CaptionPipeline) {}
    getSupport(): LiveCaptionSupport {
        return this.pipeline.getSupport();
    }
    getState(): LiveCaptionState {
        const state = this.pipeline.getState();
        return this.paused && this.intent
            ? {
                  ...state,
                  state: 'suspended',
                  active: true,
                  sessionId: this.intent.sessionId,
              }
            : state;
    }
    subscribe(listener: (state: LiveCaptionState) => void): () => void {
        return this.pipeline.subscribe(() => listener(this.getState()));
    }
    async start(
        sessionId: string,
        options?: LiveCaptionStartOptions
    ): Promise<LiveCaptionState> {
        const revision = ++this.revision;
        this.intent = { sessionId, options };
        this.paused = false;
        try {
            await this.pipeline.start(sessionId, options);
        } catch (error) {
            if (this.revision === revision) this.intent = null;
            throw error;
        }
        return this.getState();
    }
    async stop(sessionId?: string): Promise<LiveCaptionState> {
        if (!sessionId || this.intent?.sessionId === sessionId) {
            this.revision++;
            this.intent = null;
            this.paused = false;
        }
        await this.pipeline.stop(sessionId);
        return this.getState();
    }
    async setPaused(sessionId: string, paused: boolean): Promise<void> {
        if (this.intent?.sessionId === sessionId)
            this.pipeline.setUserPaused?.(paused);
        if (this.intent?.sessionId !== sessionId || this.paused === paused)
            return;
        this.paused = paused;
        const revision = ++this.revision;
        await this.pipeline.stop(sessionId);
        if (!paused && this.revision === revision && this.intent)
            await this.pipeline.start(sessionId, this.intent.options);
    }
    async withPlaybackChange<T>(
        sessionId: string,
        action: () => T | Promise<T>
    ): Promise<T> {
        const intent =
            this.intent?.sessionId === sessionId ? this.intent : null;
        const revision = ++this.revision;
        if (intent) await this.pipeline.stop(sessionId);
        const result = await action();
        if (
            intent &&
            this.intent === intent &&
            this.revision === revision &&
            !this.paused
        )
            await this.pipeline.start(sessionId, intent.options);
        return result;
    }
    reset(sessionId: string): Promise<void> {
        return this.withPlaybackChange(sessionId, () => undefined);
    }
    async refreshDisplayStyle(): Promise<void> {
        await this.pipeline.refreshDisplayStyle?.();
    }
    shutdown(): void {
        this.revision++;
        this.intent = null;
        this.pipeline.shutdown();
    }
}
