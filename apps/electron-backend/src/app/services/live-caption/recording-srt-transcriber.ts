import type { FileHandle } from 'node:fs/promises';
import type { LiveCaptionStartOptions } from '@iptvnator/shared/interfaces';
import { LiveCaptionDecodedAudioSource } from './live-caption-decoded-audio-source';
import {
    CaptionUtteranceBuffer,
    captionCues,
    type CaptionUtterance,
} from './live-caption-utterances';
import { LiveCaptionCueTranslator } from './live-caption-cue-translator';
import { SharedWhisperLease } from './live-caption-whisper-pool';
import { recordingSrtBlock } from './recording-srt';
import { readRecordingTsClock } from './recording-ts-clock';

/** Recognize the saved file so mpv's cache/rebase cannot shift exported subtitles. */
export class RecordingSrtTranscriber {
    private readonly audio = new LiveCaptionDecodedAudioSource();
    private readonly whisper = new SharedWhisperLease(1);
    private cancelled = false;
    private reject: ((error: unknown) => void) | undefined;
    cancel(): void {
        this.cancelled = true;
        this.reject?.(new Error('Subtitle export cancelled.'));
        this.audio.stop();
        this.whisper.stop();
    }

    async run(
        source: string,
        modelPath: string,
        options: LiveCaptionStartOptions,
        output: FileHandle,
        progress: (percent: number) => void
    ): Promise<number> {
        const clock = await readRecordingTsClock(source);
        if (!clock || clock.end <= clock.start)
            throw new Error('Recording has no valid audio/video timeline.');
        const duration = clock.end - clock.start;
        const translator = new LiveCaptionCueTranslator(options.translation);
        const chunks = new CaptionUtteranceBuffer();
        const queue: CaptionUtterance[] = [];
        let left = Buffer.alloc(0);
        let ended = false;
        let processing = false;
        let index = 1;
        let untranslatedCueCount = 0;
        let lastEnd = clock.start;
        let resolveDone: () => void = () => undefined;
        let rejectDone: (error: unknown) => void = () => undefined;
        const done = new Promise<void>((resolve, reject) => {
            resolveDone = resolve;
            rejectDone = reject;
        });
        this.reject = rejectDone;
        // Attach a rejection handler before asynchronous startup can fail.
        void done.catch(() => undefined);
        const process = async () => {
            if (processing || this.cancelled) return;
            processing = true;
            try {
                while (
                    !this.cancelled &&
                    (queue.length >= 2 || (ended && queue.length))
                ) {
                    const chunk = queue.shift();
                    if (!chunk) break;
                    const right =
                        queue[0]?.pcm.subarray(0, 25600) ?? Buffer.alloc(0);
                    if (chunk.voiced) {
                        const extended = {
                            ...chunk,
                            pcm: Buffer.concat([left, chunk.pcm, right]),
                            start: chunk.start - left.length / 32000,
                            end: chunk.end + right.length / 32000,
                            contentStart: chunk.start,
                            contentEnd: chunk.end,
                        };
                        const result = await this.whisper.transcribe(
                            extended.pcm
                        );
                        if (this.cancelled)
                            throw new Error('Subtitle export cancelled.');
                        const cues = captionCues(
                            result.tokens ?? [],
                            extended,
                            result.text
                        );
                        await translator.prepare(cues, () => !this.cancelled);
                        for (const cue of cues) {
                            const timed = {
                                ...cue,
                                start: Math.max(lastEnd, cue.start),
                                end: Math.min(chunk.end, cue.end),
                            };
                            const block = recordingSrtBlock(
                                timed,
                                index,
                                clock.start,
                                duration
                            );
                            if (block) {
                                await output.writeFile(block, {
                                    encoding: 'utf8',
                                });
                                lastEnd = timed.end;
                                if (!cue.translated?.trim())
                                    untranslatedCueCount++;
                                index++;
                            }
                        }
                    }
                    left = Buffer.from(
                        chunk.pcm.subarray(
                            Math.max(0, chunk.pcm.length - 19200)
                        )
                    );
                    progress(
                        Math.min(
                            99,
                            Math.round(
                                ((chunk.end - clock.start) / duration) * 100
                            )
                        )
                    );
                    this.audio.setPaused(queue.length >= 2);
                }
                if (this.cancelled)
                    throw new Error('Subtitle export cancelled.');
                if (ended && !queue.length) resolveDone();
            } catch (error) {
                rejectDone(error);
            } finally {
                processing = false;
                this.audio.setPaused(queue.length >= 2);
            }
        };
        try {
            await this.whisper.start({ modelPath, threads: options.threads });
            if (this.cancelled) throw new Error('Subtitle export cancelled.');
            await this.audio.start(
                {
                    source,
                    origin: 0,
                    position: 0,
                    aid: 'auto',
                    userAgent: '',
                    referrer: '',
                    headers: '',
                },
                (frame) => {
                    if (this.cancelled) return;
                    const chunk = chunks.push(frame);
                    if (chunk) queue.push(chunk);
                    if (queue.length > 16) {
                        rejectDone(
                            new Error(
                                'Subtitle decoding queue exceeded its limit.'
                            )
                        );
                        return;
                    }
                    this.audio.setPaused(queue.length >= 2);
                    void process();
                },
                rejectDone,
                () => {
                    const chunk = chunks.flush();
                    if (chunk) queue.push(chunk);
                    ended = true;
                    void process();
                }
            );
            await done;
            await output.sync();
            progress(100);
            return untranslatedCueCount;
        } finally {
            this.audio.stop();
            this.whisper.stop();
            translator.stop();
        }
    }
}
