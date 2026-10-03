import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type {
    LiveCaptionTranslationOptions,
    LiveCaptionTranslationProvider,
    LiveCaptionTranslationSettings,
    LiveCaptionTranslationSettingsUpdate,
} from '@iptvnator/shared/interfaces';
import { normalizeLiveCaptionTranslationBaseUrl } from './live-caption-translator';

const FILE_NAME = 'live-caption-translation.json';
const DEFAULT_GOOGLE_BASE_URL = 'https://translate.googleapis.com';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TARGET_LANGUAGE = 'Simplified Chinese';

interface PersistedLiveCaptionTranslationSettings {
    version: 1;
    enabled: boolean;
    provider: LiveCaptionTranslationProvider;
    baseUrl: string;
    model: string;
    targetLanguage: string;
    encryptedApiKey?: string;
}

function defaultBaseUrl(provider: LiveCaptionTranslationProvider): string {
    return provider === 'google-free'
        ? DEFAULT_GOOGLE_BASE_URL
        : DEFAULT_OPENAI_BASE_URL;
}

function defaults(): PersistedLiveCaptionTranslationSettings {
    return {
        version: 1,
        enabled: false,
        provider: 'google-free',
        baseUrl: DEFAULT_GOOGLE_BASE_URL,
        model: '',
        targetLanguage: DEFAULT_TARGET_LANGUAGE,
    };
}

function cleanString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeProvider(value: unknown): LiveCaptionTranslationProvider {
    return value === 'openai-compatible' ? 'openai-compatible' : 'google-free';
}

function normalizePersisted(
    value: unknown
): PersistedLiveCaptionTranslationSettings {
    const fallback = defaults();
    if (!value || typeof value !== 'object') {
        return fallback;
    }
    const raw = value as Partial<PersistedLiveCaptionTranslationSettings>;
    const provider = normalizeProvider(raw.provider);
    let baseUrl = defaultBaseUrl(provider);
    try {
        baseUrl = normalizeLiveCaptionTranslationBaseUrl(
            cleanString(raw.baseUrl, defaultBaseUrl(provider)),
            provider
        );
    } catch {
        return {
            ...fallback,
            enabled: false,
            provider,
            baseUrl: defaultBaseUrl(provider),
            model: cleanString(raw.model),
            targetLanguage:
                cleanString(raw.targetLanguage, fallback.targetLanguage) ||
                fallback.targetLanguage,
        };
    }

    const model = cleanString(raw.model);
    const encryptedApiKey =
        typeof raw.encryptedApiKey === 'string' && raw.encryptedApiKey
            ? raw.encryptedApiKey
            : undefined;
    const enabled =
        raw.enabled === true &&
        (provider === 'google-free' || Boolean(model && encryptedApiKey));

    return {
        version: 1,
        enabled,
        provider,
        baseUrl,
        model,
        targetLanguage:
            cleanString(raw.targetLanguage, fallback.targetLanguage) ||
            fallback.targetLanguage,
        ...(encryptedApiKey ? { encryptedApiKey } : {}),
    };
}

/**
 * Dedicated persistent store for live-caption translation.
 *
 * Google free translation needs no credential. OpenAI-compatible API keys are
 * encrypted using Electron safeStorage (DPAPI on Windows) and never returned
 * to renderer code. This file stays separate from ordinary Settings so a key
 * never enters settings backup, IndexedDB or the broad renderer->main mirror.
 */
export class LiveCaptionTranslationSettingsStore {
    getPublicSettings(): LiveCaptionTranslationSettings {
        const current = this.read();
        return {
            enabled: current.enabled,
            provider: current.provider,
            baseUrl: current.baseUrl,
            model: current.model,
            targetLanguage: current.targetLanguage,
            hasApiKey: Boolean(current.encryptedApiKey),
            encryptionAvailable: safeStorage.isEncryptionAvailable(),
        };
    }

    update(
        patch: LiveCaptionTranslationSettingsUpdate
    ): LiveCaptionTranslationSettings {
        const current = this.read();
        const nextProvider =
            patch.provider === undefined
                ? current.provider
                : normalizeProvider(patch.provider);
        const providerChanged = nextProvider !== current.provider;
        const requestedBaseUrl =
            patch.baseUrl === undefined
                ? providerChanged
                    ? defaultBaseUrl(nextProvider)
                    : current.baseUrl
                : patch.baseUrl;
        const nextBaseUrl = normalizeLiveCaptionTranslationBaseUrl(
            requestedBaseUrl,
            nextProvider
        );

        const next: PersistedLiveCaptionTranslationSettings = {
            ...current,
            enabled:
                typeof patch.enabled === 'boolean'
                    ? patch.enabled
                    : current.enabled,
            provider: nextProvider,
            baseUrl: nextBaseUrl,
            model:
                patch.model === undefined
                    ? providerChanged && nextProvider === 'google-free'
                        ? ''
                        : current.model
                    : cleanString(patch.model),
            targetLanguage:
                patch.targetLanguage === undefined
                    ? current.targetLanguage
                    : cleanString(patch.targetLanguage) ||
                      DEFAULT_TARGET_LANGUAGE,
        };

        // Keyed credentials are endpoint/provider-bound. Never silently reuse
        // one after changing either value.
        if (
            (providerChanged || nextBaseUrl !== current.baseUrl) &&
            patch.apiKey === undefined
        ) {
            delete next.encryptedApiKey;
        }
        if (patch.clearApiKey === true) {
            delete next.encryptedApiKey;
        }
        if (patch.apiKey !== undefined) {
            if (typeof patch.apiKey !== 'string') {
                throw new Error('Translation API key must be a string.');
            }
            const apiKey = patch.apiKey.trim();
            if (!apiKey) {
                delete next.encryptedApiKey;
            } else {
                if (!safeStorage.isEncryptionAvailable()) {
                    throw new Error(
                        'Secure credential storage is unavailable on this system.'
                    );
                }
                next.encryptedApiKey = safeStorage
                    .encryptString(apiKey)
                    .toString('base64');
            }
        }

        if (next.enabled && next.provider === 'openai-compatible') {
            if (!next.model) {
                throw new Error('Translation model is required before enabling.');
            }
            if (!next.encryptedApiKey) {
                throw new Error('Translation API key is required before enabling.');
            }
            if (!safeStorage.isEncryptionAvailable()) {
                throw new Error(
                    'Secure credential storage is unavailable on this system.'
                );
            }
        }

        this.write(next);
        return this.getPublicSettings();
    }

    /** Main-process-only resolved session options, including decrypted key. */
    resolveForSession(): LiveCaptionTranslationOptions | undefined {
        const current = this.read();
        if (!current.enabled) {
            return undefined;
        }

        if (current.provider === 'google-free') {
            return {
                enabled: true,
                provider: 'google-free',
                baseUrl: current.baseUrl,
                targetLanguage: current.targetLanguage,
            };
        }

        if (!current.encryptedApiKey) {
            return undefined;
        }
        if (!safeStorage.isEncryptionAvailable()) {
            throw new Error(
                'Secure credential storage is unavailable on this system.'
            );
        }
        let apiKey: string;
        try {
            apiKey = safeStorage.decryptString(
                Buffer.from(current.encryptedApiKey, 'base64')
            );
        } catch {
            throw new Error(
                'The saved translation API key could not be decrypted. Save it again in Settings.'
            );
        }
        return {
            enabled: true,
            provider: current.provider,
            baseUrl: current.baseUrl,
            apiKey,
            model: current.model,
            targetLanguage: current.targetLanguage,
        };
    }

    private read(): PersistedLiveCaptionTranslationSettings {
        const filePath = this.filePath();
        try {
            return normalizePersisted(
                JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
            );
        } catch (error) {
            if (
                error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'ENOENT'
            ) {
                return defaults();
            }
            return defaults();
        }
    }

    private write(value: PersistedLiveCaptionTranslationSettings): void {
        const filePath = this.filePath();
        const directory = path.dirname(filePath);
        fs.mkdirSync(directory, { recursive: true });
        const tempPath = `${filePath}.tmp`;
        fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        fs.rmSync(filePath, { force: true });
        fs.renameSync(tempPath, filePath);
    }

    private filePath(): string {
        return path.join(app.getPath('userData'), FILE_NAME);
    }
}

export const liveCaptionTranslationSettingsStore =
    new LiveCaptionTranslationSettingsStore();
