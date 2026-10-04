import {
    extractNovelCaptionText,
    findCaptionWordOverlap,
    mergeCaptionOverlap,
} from './caption-overlap';

describe('caption overlap', () => {
    it('finds the longest suffix/prefix word overlap', () => {
        expect(
            findCaptionWordOverlap(
                'The Federal Reserve decided',
                'Reserve decided to keep rates unchanged'
            )
        ).toBe(2);
    });

    it('compares overlap case-insensitively and ignores edge punctuation', () => {
        expect(
            findCaptionWordOverlap(
                'Markets moved after Powell said,',
                'SAID the outlook remains uncertain.'
            )
        ).toBe(1);
    });

    it('merges rolling hypotheses without duplicating repeated audio', () => {
        expect(
            mergeCaptionOverlap(
                'The Federal Reserve decided',
                'Reserve decided to keep rates unchanged'
            )
        ).toBe('The Federal Reserve decided to keep rates unchanged');
    });

    it('returns only novel words for the next stable segment', () => {
        expect(
            extractNovelCaptionText(
                'The Federal Reserve decided',
                'Reserve decided to keep rates unchanged'
            )
        ).toBe('to keep rates unchanged');
    });

    it('appends incoming text when windows do not overlap', () => {
        expect(mergeCaptionOverlap('First sentence.', 'Second sentence.')).toBe(
            'First sentence. Second sentence.'
        );
    });

    it('deduplicates the full six-second news window beyond sixteen words', () => {
        const words =
            'The regional council has announced a new programme that will improve local transport services and provide additional support for rural communities';
        expect(extractNovelCaptionText(words, `${words} next year.`)).toBe(
            'next year.'
        );
        expect(
            extractNovelCaptionText(
                words,
                `${words.split(' ').slice(3).join(' ')} next year.`
            )
        ).toBe('next year.');
    });

    it('does not append a whole window when Whisper revises an interior word', () => {
        expect(
            extractNovelCaptionText(
                'The regional counsel has announced a new programme for local transport services',
                'The regional council has announced a new programme for local transport services next year'
            )
        ).toBe('next year');
    });

    it('keeps unrelated speech even when it shares common short ending words', () => {
        expect(
            extractNovelCaptionText(
                'The bus was delayed in the city',
                'A new school has opened in the city today'
            )
        ).toBe('A new school has opened in the city today');
    });
});
