import { LiveCaptionDisplayPayload } from './live-caption.types';
import type { LiveCaptionAlignment } from '@iptvnator/shared/interfaces';

export interface AiCaptionAssStyle {
    playResX: number;
    playResY: number;
    sourceFontSize: number;
    translatedFontSize: number;
    sourceY: number;
    translatedY: number;
    outlineSize: number;
    shadowSize: number;
    alignment: LiveCaptionAlignment;
    sourceColor: string;
    translatedColor: string;
}

export interface AiCaptionAssOverlay {
    assEvents: string;
    playResX: number;
    playResY: number;
    z: number;
}

export const DEFAULT_AI_CAPTION_ASS_STYLE: AiCaptionAssStyle = {
    playResX: 1920,
    playResY: 1080,
    sourceFontSize: 42,
    translatedFontSize: 50,
    sourceY: 900,
    translatedY: 970,
    outlineSize: 3,
    shadowSize: 0,
    alignment: 'center',
    sourceColor: '#FFFFFF',
    translatedColor: '#FFFFFF',
};

const DEFAULT_OVERLAY_Z = 50;

/**
 * Escapes user/ASR text before it is inserted into an ASS event. The overlay
 * deliberately owns all ASS tags itself; recognised text must never be able
 * to inject positioning/style tags such as `{\\pos(...)}`.
 */
export function escapeAssText(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\r\n|\r|\n/g, '\\N');
}

function normalizeCaptionText(value?: string): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
}

function eventLine(
    text: string,
    y: number,
    fontSize: number,
    color: string,
    style: AiCaptionAssStyle
): string {
    const anchor =
        style.alignment === 'left' ? 1 : style.alignment === 'right' ? 3 : 2;
    const x = Math.round(
        style.playResX * (anchor === 1 ? 1 / 24 : anchor === 3 ? 23 / 24 : 0.5)
    );
    const rgb = /^#[0-9a-f]{6}$/i.test(color)
        ? color.slice(1).toUpperCase()
        : 'FFFFFF';
    const bgr = `${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
    return [
        `{\\an${anchor}`,
        `\\pos(${x},${Math.round(y)})`,
        `\\fs${Math.round(fontSize)}`,
        `\\bord${style.outlineSize}`,
        `\\shad${style.shadowSize}`,
        // ASS uses &HAABBGGRR& rather than the UI's #RRGGBB.
        `\\1c&H00${bgr}&`,
        '\\3c&H00000000&',
        '}',
        escapeAssText(text),
    ].join('');
}

/**
 * Builds `osd-overlay format=ass-events` data for the Windows native-view
 * player. Each output line becomes one ASS Dialogue event in mpv.
 */
export function buildAiCaptionAssOverlay(
    payload: LiveCaptionDisplayPayload,
    overrides: Partial<AiCaptionAssStyle> = {}
): AiCaptionAssOverlay {
    const style: AiCaptionAssStyle = {
        ...DEFAULT_AI_CAPTION_ASS_STYLE,
        ...overrides,
    };
    const source = normalizeCaptionText(payload.sourceText);
    const translated = normalizeCaptionText(payload.translatedText);
    const lines: string[] = [];

    if (
        source &&
        (payload.mode === 'source-only' || payload.mode === 'bilingual')
    ) {
        lines.push(
            eventLine(
                source,
                style.sourceY,
                style.sourceFontSize,
                style.sourceColor,
                style
            )
        );
    }

    if (
        translated &&
        (payload.mode === 'translated-only' || payload.mode === 'bilingual')
    ) {
        lines.push(
            eventLine(
                translated,
                style.translatedY,
                style.translatedFontSize,
                style.translatedColor,
                style
            )
        );
    }

    return {
        assEvents: lines.join('\n'),
        playResX: style.playResX,
        playResY: style.playResY,
        z: DEFAULT_OVERLAY_Z,
    };
}
