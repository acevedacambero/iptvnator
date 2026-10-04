import { LiveCaptionTimeline } from './live-caption-timeline';

describe('LiveCaptionTimeline', () => {
    const token = (text: string, startMs: number, endMs: number) => ({
        text,
        startMs,
        endMs,
    });
    it('commits overlapping audio once even when its recognised words change', () => {
        const timeline = new LiveCaptionTimeline();
        expect(
            timeline.accept(
                [
                    token(' Hello', 3800, 4100),
                    token(' world', 4300, 4800),
                    token(' tomorrow', 5500, 5900),
                ],
                0,
                6000
            )
        ).toBe('Hello world');
        expect(
            timeline.accept(
                [
                    token(' Hello', 2800, 3120),
                    token(' word', 3300, 3820),
                    token(' tomorrow', 4500, 4900),
                    token(' again', 5100, 5400),
                ],
                1000,
                7000
            )
        ).toBe('tomorrow');
    });
    it('joins subword tokens and preserves punctuation', () => {
        const timeline = new LiveCaptionTimeline();
        expect(
            timeline.accept(
                [
                    token(' Trans', 0, 100),
                    token('port', 100, 250),
                    token('.', 250, 260),
                ],
                0,
                1500
            )
        ).toBe('Transport.');
    });
    it('preserves genuinely repeated words at different audio times', () => {
        const timeline = new LiveCaptionTimeline();
        expect(
            timeline.accept(
                [token(' yes', 0, 200), token(' yes', 450, 700)],
                0,
                1500
            )
        ).toBe('yes yes');
    });
    it('resets on replacement and rejects invalid timing data', () => {
        const timeline = new LiveCaptionTimeline();
        expect(timeline.accept([token(' first', 0, 200)], 0, 1500)).toBe(
            'first'
        );
        timeline.clear();
        expect(
            timeline.accept(
                [token(' bad', -10, 300), token(' second', 0, 200)],
                0,
                1500
            )
        ).toBe('second');
    });
});
