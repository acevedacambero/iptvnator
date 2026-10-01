export type LiveCaptionSource = 'stream-subtitle' | 'asr';

export type LiveCaptionSegmentState =
    | 'partial'
    | 'stable'
    | 'translated'
    | 'displayed';

/**
 * Identifies one playback generation. `generation` must be incremented when
 * the user changes channel, seeks to a different timeline, or otherwise
 * replaces the media behind an existing embedded-MPV session. Async ASR or
 * translation results carrying an older key are discarded instead of being
 * rendered over the new programme.
 */
export interface LiveCaptionSessionKey {
    sessionId: string;
    generation: number;
}

/** A single caption unit as it moves through ASR -> translation -> display. */
export interface LiveCaptionSegment extends LiveCaptionSessionKey {
    sequence: number;
    source: LiveCaptionSource;
    sourceLanguage: string;
    targetLanguage?: string;
    startTimeSeconds?: number;
    endTimeSeconds?: number;
    originalText: string;
    translatedText?: string;
    confidence?: number;
    state: LiveCaptionSegmentState;
}

export type LiveCaptionDisplayMode =
    | 'source-only'
    | 'translated-only'
    | 'bilingual';

/**
 * Renderer-independent payload consumed by the ASS composer. Keeping this
 * separate from the ASR segment lets the UI switch language visibility and
 * style without mutating recognition state.
 */
export interface LiveCaptionDisplayPayload {
    sourceText?: string;
    translatedText?: string;
    mode: LiveCaptionDisplayMode;
}

export function isSameCaptionGeneration(
    left: LiveCaptionSessionKey,
    right: LiveCaptionSessionKey
): boolean {
    return (
        left.sessionId === right.sessionId && left.generation === right.generation
    );
}
