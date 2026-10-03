import { net } from 'electron';
import type {
    LiveCaptionTranslationOptions,
    LiveCaptionTranslationProvider,
} from '@iptvnator/shared/interfaces';

const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_GOOGLE_API_BASE_URL = 'https://translate.googleapis.com';
const GOOGLE_FALLBACK_API_BASE_URL = 'https://translate.google.com';
const DEFAULT_TARGET_LANGUAGE = 'Simplified Chinese';
const DEFAULT_TIMEOUT_MS = 8000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;

export interface LiveCaptionTranslationResult {
    text: string;
    elapsedMs: number;
}

function defaultBaseUrl(provider: LiveCaptionTranslationProvider): string {
    return provider === 'google-free'
        ? DEFAULT_GOOGLE_API_BASE_URL
        : DEFAULT_OPENAI_API_BASE_URL;
}

export function normalizeLiveCaptionTranslationBaseUrl(
    value?: string,
    provider: LiveCaptionTranslationProvider = 'openai-compatible'
): string {
    const raw = value?.trim() || defaultBaseUrl(provider);
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('Translation API URL is invalid.');
    }

    const localHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
        parsed.hostname.toLowerCase()
    );
    if (
        parsed.protocol !== 'https:' &&
        !(localHost && parsed.protocol === 'http:')
    ) {
        throw new Error(
            'Translation API URL must use HTTPS (HTTP is allowed only for localhost).'
        );
    }
    if (parsed.username || parsed.password) {
        throw new Error('Translation API URL must not contain credentials.');
    }
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
}

function normalizeTimeout(value?: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_TIMEOUT_MS;
    }
    return Math.min(
        MAX_TIMEOUT_MS,
        Math.max(MIN_TIMEOUT_MS, Math.round(value as number))
    );
}

function readOpenAiMessageText(payload: unknown): string {
    if (!payload || typeof payload !== 'object') {
        return '';
    }
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
        return '';
    }
    const message = (choices[0] as { message?: unknown } | undefined)?.message;
    if (!message || typeof message !== 'object') {
        return '';
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
        return content.trim();
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((part) => {
            if (!part || typeof part !== 'object') {
                return '';
            }
            const text = (part as { text?: unknown }).text;
            return typeof text === 'string' ? text : '';
        })
        .join('')
        .trim();
}

function readGoogleTranslation(payload: unknown): string {
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
        return '';
    }
    return (payload[0] as unknown[])
        .map((segment) => {
            if (!Array.isArray(segment)) {
                return '';
            }
            return typeof segment[0] === 'string' ? segment[0] : '';
        })
        .join('')
        .trim();
}

function googleTargetLanguageCode(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (
        !normalized ||
        normalized === 'simplified chinese' ||
        normalized === 'chinese (simplified)' ||
        normalized === 'chinese simplified' ||
        normalized === 'zh-cn' ||
        normalized === 'zh_hans' ||
        normalized === 'zh-hans'
    ) {
        return 'zh-CN';
    }
    if (/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(value.trim())) {
        return value.trim();
    }
    return 'zh-CN';
}

async function appFetch(input: string, init: RequestInit): Promise<Response> {
    // Node's global fetch does not reliably follow Electron/Chromium proxy
    // configuration on Windows. Live IPTV users commonly run the desktop app
    // behind a system proxy, so translations must use Electron's network stack
    // whenever we are actually running inside Electron.
    if (
        process.versions.electron &&
        net &&
        typeof net.fetch === 'function'
    ) {
        return net.fetch(input, init) as Promise<Response>;
    }
    return fetch(input, init);
}

function googleRequestUrl(
    baseUrl: string,
    targetLanguage: string,
    text: string
): string {
    const url = new URL(`${baseUrl}/translate_a/single`);
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'en');
    url.searchParams.set('tl', googleTargetLanguageCode(targetLanguage));
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', text);
    return url.toString();
}

/**
 * One-at-a-time translator for live captions.
 *
 * `google-free` uses Google's public web translation endpoint without a key.
 * It is intentionally treated as best-effort: callers keep showing English if
 * the service is rate-limited or unavailable. `openai-compatible` remains as
 * an optional provider for users who prefer a keyed model API.
 *
 * The client owns no queue. Callers use `busy` to drop stale intermediate
 * requests and translate the newest caption snapshot instead.
 */
export class LiveCaptionTranslator {
    private readonly provider: LiveCaptionTranslationProvider;
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly model: string;
    private readonly targetLanguage: string;
    private readonly timeoutMs: number;
    private inFlight = false;
    private abortController: AbortController | null = null;

    constructor(options: LiveCaptionTranslationOptions) {
        if (options.enabled === false) {
            throw new Error('Live-caption translation is disabled.');
        }
        this.provider = options.provider ?? 'google-free';
        if (
            this.provider !== 'google-free' &&
            this.provider !== 'openai-compatible'
        ) {
            throw new Error('Unsupported live-caption translation provider.');
        }
        this.baseUrl = normalizeLiveCaptionTranslationBaseUrl(
            options.baseUrl,
            this.provider
        );
        this.apiKey = options.apiKey?.trim() ?? '';
        this.model = options.model?.trim() ?? '';
        this.targetLanguage =
            options.targetLanguage?.trim() || DEFAULT_TARGET_LANGUAGE;
        this.timeoutMs = normalizeTimeout(options.timeoutMs);

        if (this.provider === 'openai-compatible') {
            if (!this.apiKey) {
                throw new Error('Translation API key is required.');
            }
            if (!this.model) {
                throw new Error('Translation model is required.');
            }
        }
    }

    get busy(): boolean {
        return this.inFlight;
    }

    stop(): void {
        this.abortController?.abort();
        this.abortController = null;
        this.inFlight = false;
    }

    async translate(sourceText: string): Promise<LiveCaptionTranslationResult> {
        const text = sourceText.replace(/\s+/g, ' ').trim();
        if (!text) {
            return { text: '', elapsedMs: 0 };
        }
        if (this.inFlight) {
            throw new Error('Translation request already in progress.');
        }

        this.inFlight = true;
        const startedAt = performance.now();
        const controller = new AbortController();
        this.abortController = controller;
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const translated =
                this.provider === 'google-free'
                    ? await this.translateWithGoogle(text, controller.signal)
                    : await this.translateWithOpenAi(text, controller.signal);
            if (!translated) {
                throw new Error('Translation provider returned an empty response.');
            }
            return {
                text: translated,
                elapsedMs: Math.max(
                    0,
                    Math.round(performance.now() - startedAt)
                ),
            };
        } catch (error) {
            if (controller.signal.aborted) {
                throw new Error(
                    `Translation request timed out after ${this.timeoutMs} ms.`
                );
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
            if (this.abortController === controller) {
                this.abortController = null;
            }
            this.inFlight = false;
        }
    }

    private async translateWithGoogle(
        text: string,
        signal: AbortSignal
    ): Promise<string> {
        const candidates = [this.baseUrl];
        if (this.baseUrl === DEFAULT_GOOGLE_API_BASE_URL) {
            candidates.push(GOOGLE_FALLBACK_API_BASE_URL);
        }

        let lastError: Error | null = null;
        for (const baseUrl of candidates) {
            try {
                const response = await appFetch(
                    googleRequestUrl(baseUrl, this.targetLanguage, text),
                    {
                        method: 'GET',
                        headers: {
                            Accept: 'application/json,text/plain,*/*',
                        },
                        signal,
                    }
                );
                if (!response.ok) {
                    lastError = new Error(
                        `Google translation request failed with HTTP ${response.status}.`
                    );
                    continue;
                }
                const translated = readGoogleTranslation(await response.json());
                if (translated) {
                    return translated;
                }
                lastError = new Error(
                    'Google translation returned an empty response.'
                );
            } catch (error) {
                if (signal.aborted) {
                    throw error;
                }
                lastError =
                    error instanceof Error ? error : new Error(String(error));
            }
        }

        throw (
            lastError ??
            new Error('Google translation request failed for all endpoints.')
        );
    }

    private async translateWithOpenAi(
        text: string,
        signal: AbortSignal
    ): Promise<string> {
        const response = await appFetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                messages: [
                    {
                        role: 'system',
                        content:
                            `Translate live spoken English into concise, natural ${this.targetLanguage}. ` +
                            'Preserve names, numbers, acronyms, and meaning. Return only the translation.',
                    },
                    { role: 'user', content: text },
                ],
            }),
            signal,
        });
        if (!response.ok) {
            throw new Error(
                `Translation request failed with HTTP ${response.status}.`
            );
        }
        return readOpenAiMessageText(await response.json());
    }
}
