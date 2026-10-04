export type LiveCaptionRunState =
    'inactive' | 'starting' | 'running' | 'suspended' | 'error';

export interface LiveCaptionSupport {
    supported: boolean;
    platform: string;
    reason?: string;
    processLoopbackAvailable: boolean;
    captureHelperAvailable: boolean;
    whisperHelperAvailable: boolean;
    modelConfigured: boolean;
}

export type LiveCaptionTranslationProvider =
    'google-free' | 'openai-compatible';

/**
 * Optional second-stage translation for live ASR captions.
 *
 * Translation is deliberately session-scoped. Google free translation needs
 * no credential; OpenAI-compatible providers keep their credential in the
 * main process only. Neither credential nor translated text enters MPV JSON
 * IPC until the final display overlay is built. English/source captions remain
 * fully functional when translation is disabled or temporarily fails.
 */
export interface LiveCaptionTranslationOptions {
    enabled?: boolean;
    provider?: LiveCaptionTranslationProvider;
    /** Provider API root. Google free defaults to https://translate.googleapis.com. */
    baseUrl?: string;
    /** Required only for OpenAI-compatible providers. */
    apiKey?: string;
    /** Provider model name. Required only for OpenAI-compatible providers. */
    model?: string;
    /** Human-readable target language, defaults to Simplified Chinese. */
    targetLanguage?: string;
    /** Per-request timeout. Defaults to 8 seconds. */
    timeoutMs?: number;
}

/** Renderer-safe view of the persistent translation configuration. */
export interface LiveCaptionTranslationSettings {
    enabled: boolean;
    provider: LiveCaptionTranslationProvider;
    baseUrl: string;
    model: string;
    targetLanguage: string;
    hasApiKey: boolean;
    /** Whether Electron can encrypt/decrypt an OpenAI-compatible credential. */
    encryptionAvailable: boolean;
}

/**
 * Patch accepted by the dedicated secure settings IPC. The API key is write
 * only: renderer reads expose only `hasApiKey`, never the decrypted secret.
 */
export interface LiveCaptionTranslationSettingsUpdate {
    enabled?: boolean;
    provider?: LiveCaptionTranslationProvider;
    baseUrl?: string;
    model?: string;
    targetLanguage?: string;
    apiKey?: string;
    clearApiKey?: boolean;
}

export interface LiveCaptionStartOptions {
    /** Optional absolute path; V1 UI normally relies on the configured model. */
    modelPath?: string;
    threads?: number;
    /**
     * Optional per-session override used by tests/integrations. Normal desktop
     * UI relies on the main-process translation settings instead.
     */
    translation?: LiveCaptionTranslationOptions;
}

/** Font sizes scale with the video height; values use a 1080p reference. */
export type LiveCaptionAlignment = 'left' | 'center' | 'right';

export interface LiveCaptionDisplaySettings {
    sourceFontSize: number;
    translatedFontSize: number;
    bottomMarginPercent: number;
    alignment: LiveCaptionAlignment;
    sourceColor: string;
    translatedColor: string;
}

export const DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS: Readonly<LiveCaptionDisplaySettings> =
    {
        sourceFontSize: 42,
        translatedFontSize: 50,
        bottomMarginPercent: 10.2,
        alignment: 'center',
        sourceColor: '#FFFFFF',
        translatedColor: '#FFFFFF',
    };

/**
 * Caption timing diagnostics. Media-PTS scheduling reports prepared lead and
 * display error against ASR timestamps; legacy WASAPI lag excludes translation.
 */
export interface LiveCaptionSyncTelemetry {
    /** Arrival estimates are approximate when process loopback has no timestamps. */
    clockSource?: 'wasapi' | 'arrival-estimate' | 'media-pts';
    buffering?: boolean;
    bufferAheadSeconds?: number;
    /** Scheduler error against an estimated word timestamp, not optical latency. */
    lastDisplayErrorMs?: number;
    clockAnchorCount: number;
    captionLagSampleCount: number;
    lastCaptionLagMs?: number;
    p50CaptionLagMs?: number;
    p95CaptionLagMs?: number;
}

export interface LiveCaptionRecordingExport {
    state: 'working' | 'ready' | 'error';
    filePath: string;
    progress: number;
    /** English is retained when individual translations fail. */
    untranslatedCueCount?: number;
    error?: string;
}

export interface LiveCaptionState {
    recordingSubtitle?: LiveCaptionRecordingExport;
    state: LiveCaptionRunState;
    active: boolean;
    sessionId?: string;
    generation: number;
    lastText?: string;
    lastTranslatedText?: string;
    lastInferenceMs?: number;
    lastTranslationMs?: number;
    syncTelemetry?: LiveCaptionSyncTelemetry;
    /** Non-fatal translation error; source-language captions continue. */
    translationError?: string;
    error?: string;
}
