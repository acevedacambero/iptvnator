export interface NativeSubtitleLayerStyle {
    fontSize: number;
    bottomMarginPercent: number;
    color: string;
    alignment: 'left' | 'center' | 'right';
}
export interface NativeSubtitleLayer {
    trackId: number | null;
    style: NativeSubtitleLayerStyle;
}
export interface NativeSubtitleLayers {
    upper: NativeSubtitleLayer;
    lower: NativeSubtitleLayer;
}
export interface NativeSubtitleLayerTrack {
    id: number;
    title: string;
    language: string;
    codec: string;
    textSupported: boolean;
}
export interface NativeSubtitleLayersState {
    playbackRevision: number;
    tracks: NativeSubtitleLayerTrack[];
    selectedPrimaryTrackId: number | null;
    layers: NativeSubtitleLayers | null;
    error?: string;
}
export const DEFAULT_NATIVE_SUBTITLE_STYLES: Readonly<{
    upper: NativeSubtitleLayerStyle;
    lower: NativeSubtitleLayerStyle;
}> = {
    upper: {
        fontSize: 42,
        bottomMarginPercent: 20,
        color: '#FFFFFF',
        alignment: 'center',
    },
    lower: {
        fontSize: 50,
        bottomMarginPercent: 10.2,
        color: '#FFFFFF',
        alignment: 'center',
    },
};
export function validNativeSubtitleLayerStyle(
    value: unknown
): value is NativeSubtitleLayerStyle {
    if (!value || typeof value !== 'object') return false;
    const style = value as NativeSubtitleLayerStyle;
    return (
        Number.isFinite(style.fontSize) &&
        style.fontSize >= 24 &&
        style.fontSize <= 120 &&
        Number.isFinite(style.bottomMarginPercent) &&
        style.bottomMarginPercent >= 4 &&
        style.bottomMarginPercent <= 85 &&
        typeof style.color === 'string' &&
        /^#[0-9a-f]{6}$/i.test(style.color) &&
        ['left', 'center', 'right'].includes(style.alignment)
    );
}
