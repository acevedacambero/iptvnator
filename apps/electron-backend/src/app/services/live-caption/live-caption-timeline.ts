export interface LiveCaptionTimedToken {
    text: string;
    startMs: number;
    endMs: number;
}

/** Commits speech once by audio time, independent of rolling text revisions. */
export class LiveCaptionTimeline {
    private consumedThroughMs = -1;

    accept(
        tokens: LiveCaptionTimedToken[],
        windowStartMs: number,
        windowEndMs: number
    ): string {
        const words: LiveCaptionTimedToken[] = [];
        for (const token of tokens) {
            if (
                !token.text ||
                !Number.isFinite(token.startMs) ||
                !Number.isFinite(token.endMs) ||
                token.startMs < 0 ||
                token.endMs < token.startMs
            )
                continue;
            if (/^\s/.test(token.text) || words.length === 0)
                words.push({ ...token });
            else {
                const last = words[words.length - 1];
                last.text += token.text;
                last.endMs = Math.max(last.endMs, token.endMs);
            }
        }
        const novel: string[] = [];
        // Keep the decoder's unfinished tail out of immutable CC lines.
        const stableEndMs = windowEndMs - 700;
        for (const word of words) {
            const midpoint = windowStartMs + (word.startMs + word.endMs) / 2;
            const end = windowStartMs + word.endMs;
            if (end > stableEndMs || midpoint <= this.consumedThroughMs)
                continue;
            novel.push(word.text.trim());
            this.consumedThroughMs = end;
        }
        return novel.filter(Boolean).join(' ');
    }

    clear(): void {
        this.consumedThroughMs = -1;
    }
}
