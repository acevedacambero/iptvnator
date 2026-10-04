import { CaptionUtteranceBuffer, captionCues } from './live-caption-utterances';

const frame = (pts: number, amplitude = 1000) => {
    const pcm = Buffer.alloc(3200);
    for (let index = 0; index < pcm.length; index += 2)
        pcm.writeInt16LE(amplitude, index);
    return { pts, end: pts + 0.1, pcm };
};
describe('caption utterances', () => {
    it('does not create subtitle lines from music-only symbols or replacement glyphs', () => {
        const chunk = { pcm: Buffer.alloc(0), start: 0, end: 8, voiced: true };
        expect(
            captionCues([{ text: ' ♪♪', startMs: 0, endMs: 1000 }], chunk, '♪♪')
        ).toEqual([]);
        expect(
            captionCues(
                [{ text: ' ����', startMs: 0, endMs: 1000 }],
                chunk,
                '����'
            )
        ).toEqual([]);
    });
    it('uses surrounding audio as context without replaying adjacent words', () => {
        const cues = captionCues(
            [
                { text: ' previous', startMs: 0, endMs: 300 },
                { text: ' fresh', startMs: 1000, endMs: 1500 },
                { text: ' words.', startMs: 1600, endMs: 2000 },
                { text: ' next', startMs: 8500, endMs: 9000 },
            ],
            {
                pcm: Buffer.alloc(0),
                start: 99.4,
                end: 108.8,
                contentStart: 100,
                contentEnd: 108,
                voiced: true,
            },
            'previous fresh words. next'
        );
        expect(cues.map((cue) => cue.source)).toEqual(['fresh words.']);
    });
    it('cuts at silence and starts the next utterance after the previous audio', () => {
        const buffer = new CaptionUtteranceBuffer();
        let first;
        for (let index = 0; index < 26; index++)
            first =
                buffer.push(frame(100 + index / 10, index < 20 ? 1000 : 0)) ??
                first;
        expect(first).toMatchObject({ start: 100, voiced: true });
        const next = buffer.flush();
        expect(next?.start).toBe(first?.end);
    });
    it('skips ASR on silence and bounds continuous speech chunks', () => {
        const quiet = new CaptionUtteranceBuffer();
        let silence;
        for (let index = 0; index < 21; index++)
            silence = quiet.push(frame(index / 10, 0)) ?? silence;
        expect(silence?.voiced).toBe(false);
        const loud = new CaptionUtteranceBuffer();
        let utterance;
        for (let index = 0; index < 81; index++)
            utterance = loud.push(frame(index / 10)) ?? utterance;
        expect(utterance?.pcm.length).toBeLessThanOrEqual(8.1 * 32000);
    });
    it('detects a source clock discontinuity instead of displaying misaligned captions', () => {
        const buffer = new CaptionUtteranceBuffer();
        buffer.push(frame(100));
        expect(() => buffer.push(frame(110))).toThrow('clock jumped');
    });
    it('joins BPE tokens and converts relative word times into source PTS', () => {
        const cues = captionCues(
            [
                { text: ' ultra', startMs: 100, endMs: 300 },
                { text: 'marathon', startMs: 300, endMs: 600 },
                { text: ' to', startMs: 700, endMs: 800 },
                { text: ' go.', startMs: 900, endMs: 1000 },
            ],
            { pcm: Buffer.alloc(0), start: 4000, end: 4008, voiced: true },
            'ultramarathon to go.'
        );
        expect(cues).toEqual([
            { start: 4000.1, end: 4001, source: 'ultramarathon to go.' },
        ]);
    });
    it('keeps legitimate repeated words and rejects invalid token times', () => {
        const cues = captionCues(
            [
                { text: ' very', startMs: 0, endMs: 200 },
                { text: ' very', startMs: 300, endMs: 500 },
                { text: ' clear.', startMs: 600, endMs: 900 },
                { text: ' invalid', startMs: 9000, endMs: 10000 },
            ],
            { pcm: Buffer.alloc(0), start: 100, end: 108, voiced: true },
            'very very clear.'
        );
        expect(cues[0].source).toBe('very very clear.');
    });
});
