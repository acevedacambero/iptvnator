import {
    DEFAULT_NATIVE_SUBTITLE_STYLES,
    validNativeSubtitleLayerStyle,
    type NativeSubtitleLayers,
} from '@iptvnator/shared/interfaces';

const KEY = 'iptvnator.native-subtitle-layer-styles.v1';
export function readNativeSubtitleStyles(): typeof DEFAULT_NATIVE_SUBTITLE_STYLES {
    try {
        const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
        if (
            validNativeSubtitleLayerStyle(stored?.upper) &&
            validNativeSubtitleLayerStyle(stored?.lower)
        )
            return stored;
    } catch {
        /* Older or unavailable storage uses defaults without rewriting it. */
    }
    return {
        upper: { ...DEFAULT_NATIVE_SUBTITLE_STYLES.upper },
        lower: { ...DEFAULT_NATIVE_SUBTITLE_STYLES.lower },
    };
}
export function persistNativeSubtitleStyles(
    layers: NativeSubtitleLayers
): void {
    try {
        localStorage.setItem(
            KEY,
            JSON.stringify({
                upper: layers.upper.style,
                lower: layers.lower.style,
            })
        );
    } catch {
        /* Playback still works when local storage is unavailable. */
    }
}
