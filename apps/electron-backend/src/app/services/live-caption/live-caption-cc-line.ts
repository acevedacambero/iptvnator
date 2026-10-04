const DEFAULT_WORD_LIMIT = 9;
const DEFAULT_MIN_PUNCTUATION_WORDS = 3;
const SENTENCE_END = /[.!?…]["'”’)]*$/;

function normalize(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

/**
 * Turns overlapping Whisper hypotheses into stable roll-forward CC lines.
 *
 * Words accumulate off-screen until either a natural sentence boundary is
 * reached or the line hits the configured word limit. Once emitted, a line is
 * never rewritten. This avoids the left/right jumping caused by repainting a
 * long rolling transcript on every ASR window.
 */
export class LiveCaptionCcLineBuffer {
    private buffer = '';

    constructor(
        private readonly wordLimit = DEFAULT_WORD_LIMIT,
        private readonly minPunctuationWords = DEFAULT_MIN_PUNCTUATION_WORDS
    ) {}

    push(novelText: string): string | null {
        const novel = normalize(novelText);
        if (!novel) {
            return null;
        }
        this.buffer = normalize(`${this.buffer} ${novel}`);
        return this.takeReadyLine(false);
    }

    /** Flushes one pending line, used when speech falls silent. */
    flush(): string | null {
        return this.takeReadyLine(true);
    }

    clear(): void {
        this.buffer = '';
    }

    get pendingText(): string {
        return this.buffer;
    }

    private takeReadyLine(force: boolean): string | null {
        const words = this.buffer.split(' ').filter(Boolean);
        if (words.length === 0) {
            return null;
        }

        let take = 0;
        const scanLimit = Math.min(words.length, this.wordLimit);
        for (let index = 0; index < scanLimit; index += 1) {
            if (
                index + 1 >= this.minPunctuationWords &&
                SENTENCE_END.test(words[index])
            ) {
                take = index + 1;
                break;
            }
        }

        if (take === 0 && words.length >= this.wordLimit) {
            take = this.wordLimit;
        }
        if (take === 0 && force) {
            take = Math.min(words.length, this.wordLimit);
        }
        if (take === 0) {
            return null;
        }

        const line = words.slice(0, take).join(' ');
        this.buffer = words.slice(take).join(' ');
        return line;
    }
}
