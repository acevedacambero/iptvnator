import { CaptionAudioFrame } from './live-caption-decoded-audio-source';
import { LiveCaptionTimedToken } from './live-caption-timeline';

export interface CaptionUtterance {
    pcm: Buffer;
    start: number;
    end: number;
    voiced: boolean;
    contentStart?: number;
    contentEnd?: number;
}
export interface CaptionCue {
    start: number;
    end: number;
    source: string;
    translated?: string;
}

/** Non-overlapping speech chunks with silence boundaries and a hard time cap. */
export class CaptionUtteranceBuffer {
    private frames: CaptionAudioFrame[] = [];
    private silence = 0;
    private voiced = false;
    push(frame: CaptionAudioFrame): CaptionUtterance | null {
        const previous = this.frames[this.frames.length - 1];
        if (previous && Math.abs(previous.end - frame.pts) > 0.2)
            throw new Error(
                'The caption source media clock jumped; restart captions to resynchronize.'
            );
        let energy = 0;
        for (let offset = 0; offset < frame.pcm.length; offset += 2)
            energy += (frame.pcm.readInt16LE(offset) / 32768) ** 2;
        const speech = Math.sqrt(energy / (frame.pcm.length / 2)) >= 0.004;
        this.voiced ||= speech;
        this.silence = speech ? 0 : this.silence + frame.end - frame.pts;
        this.frames.push(frame);
        const duration = frame.end - this.frames[0].pts;
        return duration >= 8 || (duration >= 2 && this.silence >= 0.4)
            ? this.flush()
            : null;
    }
    flush(): CaptionUtterance | null {
        if (!this.frames.length) return null;
        const result = {
            pcm: Buffer.concat(this.frames.map((frame) => frame.pcm)),
            start: this.frames[0].pts,
            end: this.frames[this.frames.length - 1].end,
            voiced: this.voiced,
        };
        this.frames = [];
        this.silence = 0;
        this.voiced = false;
        return result;
    }
}

/** Join BPE pieces before creating readable, timed subtitle phrases. */
export function captionCues(
    tokens: LiveCaptionTimedToken[],
    chunk: CaptionUtterance,
    text: string
): CaptionCue[] {
    const words: { text: string; start: number; end: number }[] = [];
    for (const token of tokens) {
        if (
            !token.text ||
            !Number.isFinite(token.startMs + token.endMs) ||
            token.startMs < 0 ||
            token.endMs < token.startMs ||
            token.startMs >= (chunk.end - chunk.start) * 1000
        )
            continue;
        if (/^\s/.test(token.text) || !words.length)
            words.push({
                text: token.text,
                start: chunk.start + token.startMs / 1000,
                end: Math.min(chunk.end, chunk.start + token.endMs / 1000),
            });
        else {
            const word = words[words.length - 1];
            word.text += token.text;
            word.end = Math.max(
                word.end,
                Math.min(chunk.end, chunk.start + token.endMs / 1000)
            );
        }
    }
    const freshStart = chunk.contentStart ?? chunk.start;
    const freshEnd = chunk.contentEnd ?? chunk.end;
    const freshWords = words.filter(
        (word) =>
            (word.start + word.end) / 2 >= freshStart &&
            (word.start + word.end) / 2 < freshEnd
    );
    if (!words.length)
        return /[A-Za-z0-9]/.test(text)
            ? [{ start: freshStart, end: freshEnd, source: text.trim() }]
            : [];
    const cues: CaptionCue[] = [];
    let phrase: typeof words = [];
    const emit = () => {
        if (!phrase.length) return;
        cues.push({
            start: phrase[0].start,
            end: Math.min(
                chunk.end,
                Math.max(phrase[0].start + 0.6, phrase[phrase.length - 1].end)
            ),
            source: phrase.map((word) => word.text.trim()).join(' '),
        });
        phrase = [];
    };
    for (const word of freshWords) {
        phrase.push(word);
        if (
            phrase.length >= 12 ||
            (phrase.length >= 3 && /[.!?]["'”’)]*$/.test(word.text)) ||
            (phrase.length >= 6 && /[,;:]$/.test(word.text))
        )
            emit();
    }
    emit();
    for (let index = 0; index < cues.length - 1; index++)
        cues[index].end = Math.min(cues[index].end, cues[index + 1].start);
    return cues.filter((cue) => cue.end > cue.start && /[A-Za-z0-9]/.test(cue.source));
}
