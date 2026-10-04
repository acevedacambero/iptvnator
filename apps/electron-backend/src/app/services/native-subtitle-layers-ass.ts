import type { NativeSubtitleLayers } from '@iptvnator/shared/interfaces';
import { escapeAssText } from './live-caption/ai-caption-ass';

/** MPV supplies already-decoded plain text at the current playback position. */
export function buildNativeSubtitleLayerAss(
    layers: NativeSubtitleLayers,
    upper: string,
    lower: string
): string {
    return (
        [
            ['upper', upper],
            ['lower', lower],
        ] as const
    )
        .flatMap(([key, raw]) => {
            const layer = layers[key];
            const text = raw.split('\0').join('').slice(0, 16000).trim();
            if (layer.trackId === null || !text) return [];
            const { fontSize, bottomMarginPercent, color, alignment } =
                layer.style;
            const anchor =
                alignment === 'left' ? 1 : alignment === 'right' ? 3 : 2;
            const x = anchor === 1 ? 80 : anchor === 3 ? 1840 : 960;
            const y = Math.round(1080 * (1 - bottomMarginPercent / 100));
            const rgb = color.slice(1).toUpperCase();
            const bgr = rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2);
            return [
                `{\\an${anchor}\\pos(${x},${y})\\fs${fontSize}\\bord3\\shad0\\1c&H00${bgr}&\\3c&H00000000&}${escapeAssText(text)}`,
            ];
        })
        .join('\n');
}
