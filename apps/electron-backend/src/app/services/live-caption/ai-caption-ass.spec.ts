import {
    buildAiCaptionAssOverlay,
    escapeAssText,
} from './ai-caption-ass';

describe('AI caption ASS overlay', () => {
    it('renders bilingual captions as two white ASS events with black outlines', () => {
        const overlay = buildAiCaptionAssOverlay({
            mode: 'bilingual',
            sourceText: 'The Federal Reserve kept rates unchanged.',
            translatedText: '美联储维持利率不变。',
        });

        const lines = overlay.assEvents.split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('The Federal Reserve kept rates unchanged.');
        expect(lines[1]).toContain('美联储维持利率不变。');
        expect(lines[0]).toContain('\\pos(960,900)');
        expect(lines[1]).toContain('\\pos(960,970)');
        expect(lines[0]).toContain('\\1c&H00FFFFFF&');
        expect(lines[1]).toContain('\\1c&H00FFFFFF&');
        expect(lines[0]).toContain('\\3c&H00000000&');
        expect(lines[1]).toContain('\\3c&H00000000&');
        expect(lines[0]).toContain('\\bord3');
        expect(lines[1]).toContain('\\bord3');
        expect(lines[0]).toContain('\\shad0');
        expect(lines[1]).toContain('\\shad0');
        expect(overlay).toMatchObject({
            playResX: 1920,
            playResY: 1080,
            z: 50,
        });
    });

    it('keeps font size and vertical position overrideable for the settings UI', () => {
        const overlay = buildAiCaptionAssOverlay(
            {
                mode: 'bilingual',
                sourceText: 'English',
                translatedText: '中文',
            },
            {
                sourceFontSize: 48,
                translatedFontSize: 56,
                sourceY: 840,
                translatedY: 920,
            }
        );

        const lines = overlay.assEvents.split('\n');
        expect(lines[0]).toContain('\\fs48');
        expect(lines[1]).toContain('\\fs56');
        expect(lines[0]).toContain('\\pos(960,840)');
        expect(lines[1]).toContain('\\pos(960,920)');
    });

    it('omits the hidden language in single-language modes', () => {
        const sourceOnly = buildAiCaptionAssOverlay({
            mode: 'source-only',
            sourceText: 'English',
            translatedText: '中文',
        });
        expect(sourceOnly.assEvents).toContain('English');
        expect(sourceOnly.assEvents).not.toContain('中文');

        const translatedOnly = buildAiCaptionAssOverlay({
            mode: 'translated-only',
            sourceText: 'English',
            translatedText: '中文',
        });
        expect(translatedOnly.assEvents).not.toContain('English');
        expect(translatedOnly.assEvents).toContain('中文');
    });

    it('escapes ASS control characters from recognised text', () => {
        expect(escapeAssText('{\\pos(1,2)}\nnext')).toBe(
            '\\{\\\\pos(1,2)\\}\\Nnext'
        );
    });

    it('returns an empty overlay when there is nothing to display', () => {
        expect(
            buildAiCaptionAssOverlay({ mode: 'bilingual' }).assEvents
        ).toBe('');
    });
});
