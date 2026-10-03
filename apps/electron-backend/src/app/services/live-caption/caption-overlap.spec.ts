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
});
