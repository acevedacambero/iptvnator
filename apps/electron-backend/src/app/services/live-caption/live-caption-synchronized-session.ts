import type {
    LiveCaptionStartOptions,
    LiveCaptionState,
} from '@iptvnator/shared/interfaces';
import { buildAiCaptionAssOverlay } from './ai-caption-ass';
import {
    CaptionAudioFrame,
    LiveCaptionDecodedAudioSource,
} from './live-caption-decoded-audio-source';
import { liveCaptionDisplaySettingsStore } from './live-caption-display-settings.store';
import { liveCaptionMpvOverlayService as player } from './live-caption-mpv-overlay.service';
import { LiveCaptionSchedule } from './live-caption-schedule';
import { LiveCaptionCueTranslator } from './live-caption-cue-translator';
import {
    captionCues,
    CaptionCue,
    CaptionUtterance,
    CaptionUtteranceBuffer,
} from './live-caption-utterances';
import { SharedWhisperLease } from './live-caption-whisper-pool';

/** Decode ahead without audible output, prepare both languages, then follow PTS. */
export class LiveCaptionSynchronizedSession {
    private readonly audio = new LiveCaptionDecodedAudioSource();
    private readonly whisper = new SharedWhisperLease();
    private readonly chunks = new CaptionUtteranceBuffer();
    private readonly schedule = new LiveCaptionSchedule();
    private translations: LiveCaptionCueTranslator | null = null;
    private queue: CaptionUtterance[] = [];
    private leftContext = Buffer.alloc(0);
    private timer: NodeJS.Timeout | null = null;
    private processing = false;
    private ticking = false;
    private stopped = false;
    private userPaused = false;
    private ownedPause = false;
    private origin = 0;
    private position = 0;
    private decodedThrough = 0;
    private firstFrame = true;
    private inputEnded = false;
    private displayed: CaptionCue | null = null;
    private lastInferenceMs: number | undefined;
    private displayErrorMs: number | undefined;
    private sampleCount = 0;
    private ahead = 0;

    constructor(
        private readonly sessionId: string,
        private readonly current: () => boolean,
        private readonly changed: () => void,
        private readonly failed: (error: unknown) => void
    ) {}

    async start(
        modelPath: string,
        options: LiveCaptionStartOptions
    ): Promise<void> {
        await this.whisper.start({ modelPath, threads: options.threads });
        if (!this.valid()) return;
        const context = await this.waitForPlayback();
        if (!this.valid()) return;
        this.origin = context.origin;
        this.position = this.decodedThrough = context.origin + context.position;
        this.userPaused = context.paused;
        this.translations = new LiveCaptionCueTranslator(options.translation);
        if (!context.paused) {
            this.ownedPause = true;
            await player.setCaptionBuffering(this.sessionId, true);
        }
        if (!this.valid()) return;
        await this.audio.start(
            context,
            (frame) => this.onFrame(frame),
            (error) => this.failed(error),
            () => {
                const chunk = this.chunks.flush();
                if (chunk) this.queue.push(chunk);
                this.inputEnded = true;
                void this.process();
            }
        );
        if (!this.valid()) return;
        this.timer = setInterval(() => void this.tick(), 60);
        this.timer.unref();
        const startup = setTimeout(() => {
            if (this.valid() && this.firstFrame)
                this.failed(
                    new Error(
                        'The caption source did not supply timestamped audio.'
                    )
                );
        }, 20000);
        startup.unref();
        this.changed();
    }

    setUserPaused(paused: boolean): void {
        this.userPaused = paused;
        if (!paused) this.ownedPause = false;
    }

    private async waitForPlayback(): Promise<
        Awaited<ReturnType<typeof player.getCaptionPlaybackContext>>
    > {
        let lastError: unknown;
        for (let attempt = 0; attempt < 100 && this.valid(); attempt++) {
            try {
                return await player.getCaptionPlaybackContext(this.sessionId);
            } catch (error) {
                lastError = error;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw lastError ?? new Error('Caption playback was cancelled.');
    }
    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.audio.stop();
        this.whisper.stop();
        this.translations?.stop();
        this.queue = [];
        await player.clearOverlay(this.sessionId).catch(() => undefined);
        if (this.ownedPause && !this.userPaused)
            await player
                .setCaptionBuffering(this.sessionId, false)
                .catch(() => undefined);
        this.ownedPause = false;
    }
    async redraw(): Promise<void> {
        if (this.valid() && this.displayed) await this.paint(this.displayed);
    }
    snapshot(): Partial<LiveCaptionState> {
        return {
            ...(this.displayed
                ? {
                      lastText: this.displayed.source,
                      ...(this.displayed.translated
                          ? { lastTranslatedText: this.displayed.translated }
                          : {}),
                  }
                : {}),
            ...(this.lastInferenceMs !== undefined
                ? { lastInferenceMs: this.lastInferenceMs }
                : {}),
            ...this.translations?.snapshot(),
            syncTelemetry: {
                clockSource: 'media-pts',
                clockAnchorCount: this.firstFrame ? 0 : 1,
                captionLagSampleCount: this.sampleCount,
                buffering: this.ownedPause,
                bufferAheadSeconds: this.ahead,
                ...(this.displayErrorMs !== undefined
                    ? { lastDisplayErrorMs: this.displayErrorMs }
                    : {}),
            },
        };
    }
    private valid(): boolean {
        return !this.stopped && this.current();
    }

    private onFrame(frame: CaptionAudioFrame): void {
        if (!this.valid() || (frame.end <= this.position && this.firstFrame))
            return;
        if (this.firstFrame) {
            this.firstFrame = false;
            if (frame.pts > this.position + 0.15) {
                this.position = frame.pts;
                void player
                    .alignCaptionPlayback(
                        this.sessionId,
                        frame.pts - this.origin
                    )
                    .catch(this.failed);
            }
        }
        this.decodedThrough = frame.end;
        const chunk = this.chunks.push(frame);
        if (chunk) this.queue.push(chunk);
        if (this.queue.length > 8) {
            this.failed(
                new Error(
                    'Caption recognition cannot keep up with this stream.'
                )
            );
            return;
        }
        this.audio.setPaused(this.decoderShouldPause());
        void this.process();
    }

    private async process(): Promise<void> {
        if (this.processing || !this.valid()) return;
        this.processing = true;
        try {
            while (
                (this.queue.length >= 2 ||
                    (this.inputEnded && this.queue.length)) &&
                this.valid()
            ) {
                const chunk = this.queue.shift();
                if (!chunk) break;
                const rightContext =
                    this.queue[0]?.pcm.subarray(0, 25600) ?? Buffer.alloc(0);
                const extended = {
                    ...chunk,
                    pcm: Buffer.concat([
                        this.leftContext,
                        chunk.pcm,
                        rightContext,
                    ]),
                    start: chunk.start - this.leftContext.length / 32000,
                    end: chunk.end + rightContext.length / 32000,
                    contentStart: chunk.start,
                    contentEnd: chunk.end,
                };
                this.leftContext = Buffer.from(
                    chunk.pcm.subarray(Math.max(0, chunk.pcm.length - 19200))
                );
                let cues: CaptionCue[] = [];
                if (chunk.voiced) {
                    const result = await this.whisper.transcribe(extended.pcm);
                    if (!this.valid()) return;
                    this.lastInferenceMs = result.elapsedMs;
                    cues = captionCues(
                        result.tokens ?? [],
                        extended,
                        result.text
                    );
                    await this.translations?.prepare(cues, () => this.valid());
                }
                if (!this.valid()) return;
                this.schedule.add(cues, chunk.end);
                this.changed();
            }
            if (this.inputEnded && this.valid()) this.schedule.ended = true;
        } catch (error) {
            if (this.valid()) this.failed(error);
        } finally {
            this.processing = false;
        }
    }

    private async tick(): Promise<void> {
        if (this.ticking || !this.valid()) return;
        this.ticking = true;
        try {
            const relative = await player.getPlaybackPositionSeconds(
                this.sessionId
            );
            if (!this.valid() || relative === null) return;
            this.position = relative + this.origin;
            const next = this.schedule.at(this.position);
            this.ahead = next.ahead;
            if (!this.userPaused && next.hold !== this.ownedPause) {
                this.ownedPause = next.hold;
                await player.setCaptionBuffering(this.sessionId, next.hold);
                if (!this.valid()) return;
                this.changed();
            }
            this.audio.setPaused(this.decoderShouldPause());
            if (next.cue !== this.displayed) {
                this.displayed = next.cue;
                if (next.cue) {
                    this.displayErrorMs = Math.max(
                        0,
                        (this.position - next.cue.start) * 1000
                    );
                    this.sampleCount++;
                    await this.paint(next.cue);
                } else await player.clearOverlay(this.sessionId);
                if (this.valid()) this.changed();
            }
        } catch (error) {
            if (this.valid()) this.failed(error);
        } finally {
            this.ticking = false;
        }
    }
    private paint(cue: CaptionCue): Promise<void> {
        return player.setOverlay(
            this.sessionId,
            buildAiCaptionAssOverlay(
                {
                    sourceText: cue.source,
                    translatedText: cue.translated,
                    mode: cue.translated ? 'bilingual' : 'source-only',
                },
                liveCaptionDisplaySettingsStore.getAssStyle()
            )
        );
    }

    private decoderShouldPause(): boolean {
        // Finish the next utterance while held, even near the lead cap. Without
        // this allowance decoding can stop just short of the required context.
        return (
            this.queue.length >= 3 ||
            (this.decodedThrough - this.position >= 24 &&
                !(this.schedule.held && this.queue.length < 2))
        );
    }
}
