import { CaptionCue } from './live-caption-utterances';

/** Cue visibility follows media time, including stalls; wall time never advances it. */
export class LiveCaptionSchedule {
    private cues: CaptionCue[] = [];
    readyThrough = Number.NEGATIVE_INFINITY;
    ended = false;
    held = true;
    add(cues: CaptionCue[], readyThrough: number): void {
        this.cues.push(...cues);
        if (this.cues.length > 100)
            throw new Error(
                'The synchronized caption queue exceeded its limit.'
            );
        this.readyThrough = Math.max(this.readyThrough, readyThrough);
    }
    at(position: number): {
        cue: CaptionCue | null;
        hold: boolean;
        ahead: number;
    } {
        while (this.cues.length && this.cues[0].end <= position)
            this.cues.shift();
        const ahead = Math.max(0, this.readyThrough - position);
        if (this.held && (ahead >= 10 || (this.ended && ahead > 0)))
            this.held = false;
        else if (!this.held && ahead < 0.8 && !this.ended) this.held = true;
        const cue =
            this.cues.find(
                (cue) => cue.start <= position && position < cue.end
            ) ?? null;
        return { cue, hold: this.held, ahead };
    }
}
