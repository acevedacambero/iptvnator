import type { CaptionCue } from './live-caption-utterances';

export function srtTimestamp(seconds: number): string {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const pad = (value: number, digits = 2) =>
        String(value).padStart(digits, '0');
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}
export function recordingSrtBlock(
    cue: CaptionCue,
    index: number,
    origin: number,
    duration: number
): string {
    if (![cue.start, cue.end, origin, duration].every(Number.isFinite))
        return '';
    const start = Math.max(0, cue.start - origin);
    const end = Math.min(duration, cue.end - origin);
    const clean = (text: string) =>
        text
            .split('\0')
            .join(' ')
            .replace(/[\r\n]+/g, ' ')
            .trim()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    const lines = [cue.source, cue.translated]
        .filter((value): value is string => !!value)
        .map(clean)
        .filter(Boolean);
    if (end <= start || !lines.length) return '';
    return `${index}\r\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\r\n${lines.join('\r\n')}\r\n\r\n`;
}
