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

export interface LiveCaptionStartOptions {
    /** Optional absolute path; V1 UI normally relies on the configured model. */
    modelPath?: string;
    threads?: number;
}

export interface LiveCaptionState {
    state: LiveCaptionRunState;
    active: boolean;
    sessionId?: string;
    generation: number;
    lastText?: string;
    lastInferenceMs?: number;
    error?: string;
}
