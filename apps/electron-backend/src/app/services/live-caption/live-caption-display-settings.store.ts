import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
    DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS,
    type LiveCaptionDisplaySettings,
} from '@iptvnator/shared/interfaces';
import type { AiCaptionAssStyle } from './ai-caption-ass';

const ranges = {
    sourceFontSize: [24, 96],
    translatedFontSize: [24, 120],
    bottomMarginPercent: [4, 75],
} as const;

function validate(value: unknown): LiveCaptionDisplaySettings {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid caption display settings.');
    const result = { ...DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS };
    for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
        const number = (value as Record<string, unknown>)[key];
        const [min, max] = ranges[key];
        if (
            typeof number !== 'number' ||
            !Number.isFinite(number) ||
            number < min ||
            number > max
        )
            throw new Error(
                `Caption ${key} must be between ${min} and ${max}.`
            );
        result[key] =
            key === 'bottomMarginPercent'
                ? Math.round(number * 10) / 10
                : Math.round(number);
    }
    const incoming = value as Record<string, unknown>;
    const alignment =
        incoming.alignment === undefined ? 'center' : incoming.alignment;
    if (alignment !== 'left' && alignment !== 'center' && alignment !== 'right')
        throw new Error('Caption alignment must be left, center or right.');
    result.alignment = alignment;
    for (const key of ['sourceColor', 'translatedColor'] as const) {
        const color =
            incoming[key] === undefined
                ? DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS[key]
                : incoming[key];
        if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))
            throw new Error('Caption colors must use the #RRGGBB format.');
        result[key] = color.toUpperCase();
    }
    return result;
}

export class LiveCaptionDisplaySettingsStore {
    constructor(private readonly directory = () => app.getPath('userData')) {}

    get(): LiveCaptionDisplaySettings {
        try {
            const raw = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
            return raw.version === 1
                ? validate(raw)
                : { ...DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS };
        } catch {
            return { ...DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS };
        }
    }

    update(value: unknown): LiveCaptionDisplaySettings {
        const next = validate(value);
        const file = this.filePath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        try {
            fs.writeFileSync(
                temporary,
                JSON.stringify({ version: 1, ...next }),
                'utf8'
            );
            fs.renameSync(temporary, file);
        } finally {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
        return next;
    }

    getAssStyle(): Partial<AiCaptionAssStyle> {
        const settings = this.get();
        const translatedY = Math.round(
            1080 * (1 - settings.bottomMarginPercent / 100)
        );
        return {
            sourceFontSize: settings.sourceFontSize,
            translatedFontSize: settings.translatedFontSize,
            sourceY:
                translatedY -
                Math.max(settings.sourceFontSize, settings.translatedFontSize) -
                20,
            translatedY,
            alignment: settings.alignment,
            sourceColor: settings.sourceColor,
            translatedColor: settings.translatedColor,
        };
    }

    private filePath(): string {
        return path.join(this.directory(), 'live-caption-display.json');
    }
}

export const liveCaptionDisplaySettingsStore =
    new LiveCaptionDisplaySettingsStore();
