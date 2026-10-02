export type LiveCaptionRunState =
    | 'inactive'
    | 'starting'
    | 'running'
    | 'error';

export interface LiveCaptionSupport {
    supported: boolean;
    platform: string;
    reason?: string;
    processLoopbackAvailable: boolean;
    captureHelperAvailable: boolean;
    whisperHelperAvailable: boolean;
    modelConfigured: boolean;
}

export type LiveCaptionTranslationProvider = 'openai-compatible';

/**
 * Optional second-stage translation for live ASR captions.
 *
 * Translation is deliberately session-scoped. The main process receives the
 * credential only when captions are started; it is not part of MPV JSON IPC
 * and must never be logged. English/source captions remain fully functional
 * when translation is disabled or temporarily fails.
 */
export interface LiveCaptionTranslationOptions {
    enabled?: boolean;
    provider?: LiveCaptionTranslationProvider;
    /** OpenAI-compatible API root, e.g. https://api.openai.com/v1. */
    baseUrl?: string;
    apiKey?: string;
    /** Provider model name. Required when translation is enabled. */
    model?: string;
    /** Human-readable target language, defaults to Simplified Chinese. */
    targetLanguage?: string;
    /** Per-request timeout. Defaults to 8 seconds. */
    timeoutMs?: number;
}

export interface LiveCaptionStartOptions {
    /** Optional absolute path; V1 UI normally relies on the configured model. */
    modelPath?: string;
    threads?: number;
    translation?: LiveCaptionTranslationOptions;
}

export interface LiveCaptionState {
    state: LiveCaptionRunState;
    active: boolean;
    sessionId?: string;
    generation: number;
    lastText?: string;
    lastTranslatedText?: string;
    lastInferenceMs?: number;
    lastTranslationMs?: number;
    /** Non-fatal translation error; source-language captions continue. */
    translationError?: string;
    error?: string;
}
