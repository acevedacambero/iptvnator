import type {
    LiveCaptionState,
    LiveCaptionTranslationOptions,
} from '@iptvnator/shared/interfaces';
import { buildAiCaptionAssOverlay } from './ai-caption-ass';
import { liveCaptionMpvOverlayService } from './live-caption-mpv-overlay.service';
import { liveCaptionTranslationSettingsStore } from './live-caption-translation-settings.store';
import { LiveCaptionTranslator } from './live-caption-translator';
import { liveCaptionDisplaySettingsStore } from './live-caption-display-settings.store';

interface TranslationRequest {
    sourceText: string;
    revision: number;
}
const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

/** Stable line ownership and newest-only translation, independent of capture. */
export class LiveCaptionLinePresenter {
    private translator: LiveCaptionTranslator | null = null;
    private committed = '';
    private translated = '';
    private revision = 0;
    private pending: TranslationRequest | null = null;
    private elapsedMs: number | undefined;
    private error: string | undefined;
    private disposed = false;

    constructor(
        private readonly sessionId: string,
        options: LiveCaptionTranslationOptions | undefined,
        private readonly current: () => boolean,
        private readonly changed: () => void
    ) {
        try {
            const resolved =
                options ??
                liveCaptionTranslationSettingsStore.resolveForSession();
            if (resolved?.enabled)
                this.translator = new LiveCaptionTranslator(resolved);
        } catch (error) {
            this.error = message(error);
        }
    }

    async commit(sourceText: string): Promise<void> {
        if (!this.current() || this.disposed) return;
        const line = sourceText.replace(/\s+/g, ' ').trim();
        if (!line) return;
        this.committed = line;
        const revision = ++this.revision;
        this.translated = '';
        await liveCaptionMpvOverlayService.setOverlay(
            this.sessionId,
            buildAiCaptionAssOverlay(
                { sourceText: line, mode: 'source-only' },
                liveCaptionDisplaySettingsStore.getAssStyle()
            )
        );
        const request = { sourceText: line, revision };
        if (!this.matches(request)) return;
        this.changed();
        this.queue(request);
    }

    async clear(): Promise<void> {
        this.revision++;
        this.committed = this.translated = '';
        this.pending = null;
        await liveCaptionMpvOverlayService.clearOverlay(this.sessionId);
    }

    dispose(): void {
        this.disposed = true;
        this.revision++;
        this.pending = null;
        this.translator?.stop();
    }

    async redraw(): Promise<void> {
        if (!this.current() || this.disposed || !this.committed) return;
        await liveCaptionMpvOverlayService.setOverlay(
            this.sessionId,
            buildAiCaptionAssOverlay(
                {
                    sourceText: this.committed,
                    translatedText: this.translated,
                    mode: this.translated ? 'bilingual' : 'source-only',
                },
                liveCaptionDisplaySettingsStore.getAssStyle()
            )
        );
    }

    snapshot(): Partial<LiveCaptionState> {
        return {
            ...(this.committed ? { lastText: this.committed } : {}),
            ...(this.translated ? { lastTranslatedText: this.translated } : {}),
            ...(this.elapsedMs !== undefined
                ? { lastTranslationMs: this.elapsedMs }
                : {}),
            ...(this.error ? { translationError: this.error } : {}),
        };
    }

    private queue(request: TranslationRequest): void {
        if (!this.translator || !this.matches(request)) return;
        if (this.translator.busy) {
            this.pending = request;
            return;
        }
        this.pending = null;
        void this.translate(request);
    }

    private async translate(request: TranslationRequest): Promise<void> {
        const translator = this.translator;
        if (!translator) return;
        try {
            const result = await translator.translate(request.sourceText);
            if (!this.matches(request)) return;
            this.translated = result.text;
            this.elapsedMs = result.elapsedMs;
            this.error = undefined;
            await liveCaptionMpvOverlayService.setOverlay(
                this.sessionId,
                buildAiCaptionAssOverlay(
                    {
                        sourceText: request.sourceText,
                        translatedText: result.text,
                        mode: 'bilingual',
                    },
                    liveCaptionDisplaySettingsStore.getAssStyle()
                )
            );
            if (this.matches(request)) this.changed();
        } catch (error) {
            if (this.matches(request)) {
                this.error = message(error);
                this.translated = '';
                this.changed();
            }
        } finally {
            if (!this.disposed && this.current()) {
                const pending = this.pending;
                this.pending = null;
                if (pending && this.matches(pending)) this.queue(pending);
            }
        }
    }

    private matches(request: TranslationRequest): boolean {
        return (
            this.current() &&
            !this.disposed &&
            request.revision === this.revision &&
            request.sourceText === this.committed
        );
    }
}
