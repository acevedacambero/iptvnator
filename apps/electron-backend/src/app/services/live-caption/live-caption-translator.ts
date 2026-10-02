import type { LiveCaptionTranslationOptions } from '@iptvnator/shared/interfaces';

const DEFAULT_API_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TARGET_LANGUAGE = 'Simplified Chinese';
const DEFAULT_TIMEOUT_MS = 8000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;

export interface LiveCaptionTranslationResult {
    text: string;
    elapsedMs: number;
}

export function normalizeLiveCaptionTranslationBaseUrl(value?: string): string {
    const raw = value?.trim() || DEFAULT_API_BASE_URL;
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('Translation API URL is invalid.');
    }

    const localHost = ['localhost', '127.0.0.1', '::1'].includes(
        parsed.hostname.toLowerCase()
    );
    if (parsed.protocol !== 'https:' && !(localHost && parsed.protocol === 'http:')) {
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

function readMessageText(payload: unknown): string {
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

/**
 * One-at-a-time OpenAI-compatible translator for live captions.
 *
 * The client intentionally owns no queue. Callers use `busy` to drop stale
 * intermediate requests and translate the newest caption snapshot instead.
 */
export class LiveCaptionTranslator {
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
        if ((options.provider ?? 'openai-compatible') !== 'openai-compatible') {
            throw new Error('Unsupported live-caption translation provider.');
        }
        this.apiKey = options.apiKey?.trim() ?? '';
        this.model = options.model?.trim() ?? '';
        this.baseUrl = normalizeLiveCaptionTranslationBaseUrl(options.baseUrl);
        this.targetLanguage =
            options.targetLanguage?.trim() || DEFAULT_TARGET_LANGUAGE;
        this.timeoutMs = normalizeTimeout(options.timeoutMs);

        if (!this.apiKey) {
            throw new Error('Translation API key is required.');
        }
        if (!this.model) {
            throw new Error('Translation model is required.');
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
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(
                    `Translation request failed with HTTP ${response.status}.`
                );
            }

            const translated = readMessageText(await response.json());
            if (!translated) {
                throw new Error('Translation provider returned an empty response.');
            }
            return {
                text: translated,
                elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
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
}
