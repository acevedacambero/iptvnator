import type {
    LiveCaptionState,
    LiveCaptionTranslationOptions,
} from '@iptvnator/shared/interfaces';
import { liveCaptionTranslationSettingsStore } from './live-caption-translation-settings.store';
import { LiveCaptionTranslator } from './live-caption-translator';
import type { CaptionCue } from './live-caption-utterances';

/** Prepare translations before their media interval is released for playback. */
export class LiveCaptionCueTranslator {
    private translator: LiveCaptionTranslator | null = null;
    private elapsedMs: number | undefined;
    private error: string | undefined;
    constructor(options?: LiveCaptionTranslationOptions) {
        try {
            const resolved =
                options ??
                liveCaptionTranslationSettingsStore.resolveForSession();
            if (resolved?.enabled)
                this.translator = new LiveCaptionTranslator(resolved);
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }
    }
    async prepare(cues: CaptionCue[], current: () => boolean): Promise<void> {
        const translator = this.translator;
        if (!translator) return;
        for (const cue of cues) {
            if (!current()) return;
            try {
                const result = await translator.translate(cue.source);
                if (!current()) return;
                cue.translated = result.text;
                this.elapsedMs = result.elapsedMs;
                this.error = undefined;
            } catch (error) {
                if (!current()) return;
                this.error =
                    error instanceof Error ? error.message : String(error);
            }
        }
    }
    snapshot(): Partial<LiveCaptionState> {
        return {
            ...(this.elapsedMs !== undefined
                ? { lastTranslationMs: this.elapsedMs }
                : {}),
            ...(this.error ? { translationError: this.error } : {}),
        };
    }
    stop(): void {
        this.translator?.stop();
    }
}
