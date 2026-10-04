import { DEFAULT_NATIVE_SUBTITLE_STYLES } from '@iptvnator/shared/interfaces';
import {
    readNativeSubtitleStyles,
    persistNativeSubtitleStyles,
} from './native-subtitle-layer-preferences';

describe('native subtitle style preferences', () => {
    beforeEach(() => localStorage.clear());
    it('preserves independent styles and does not persist per-video track ids', () => {
        const upper = {
            ...DEFAULT_NATIVE_SUBTITLE_STYLES.upper,
            fontSize: 64,
            color: '#FFE066',
        };
        const lower = {
            ...DEFAULT_NATIVE_SUBTITLE_STYLES.lower,
            fontSize: 72,
            bottomMarginPercent: 8,
            color: '#66D9FF',
        };
        persistNativeSubtitleStyles({
            upper: { trackId: 4, style: upper },
            lower: { trackId: 9, style: lower },
        });
        expect(readNativeSubtitleStyles()).toEqual({ upper, lower });
        expect(
            localStorage.getItem('iptvnator.native-subtitle-layer-styles.v1')
        ).not.toContain('trackId');
    });
    it('does not rewrite invalid saved styles and keeps AI styles independent', () => {
        localStorage.setItem(
            'iptvnator.native-subtitle-layer-styles.v1',
            'invalid'
        );
        expect(readNativeSubtitleStyles()).toEqual(
            DEFAULT_NATIVE_SUBTITLE_STYLES
        );
        expect(
            localStorage.getItem('iptvnator.native-subtitle-layer-styles.v1')
        ).toBe('invalid');
    });
});
