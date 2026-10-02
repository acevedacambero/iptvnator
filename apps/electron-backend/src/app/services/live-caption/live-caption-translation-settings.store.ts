import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type {
    LiveCaptionTranslationOptions,
    LiveCaptionTranslationSettings,
    LiveCaptionTranslationSettingsUpdate,
} from '@iptvnator/shared/interfaces';

const FILE_NAME = 'live-caption-translation.json';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TARGET_LANGUAGE = 'Simplified Chinese';

interface PersistedLiveCaptionTranslationSettings {
    version: 1;
    enabled: boolean;
    provider: 'openai-compatible';
    baseUrl: string;
    model: string;
    targetLanguage: string;
    encryptedApiKey?: string;
}

function defaults(): PersistedLiveCaptionTranslationSettings {
    return {
        version: 1,
        enabled: false,
        provider: 'openai-compatible',
        baseUrl: DEFAULT_BASE_URL,
        model: '',
        targetLanguage: DEFAULT_TARGET_LANGUAGE,
    };
}

function cleanString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value.trim() : fallback;
}

function normalizePersisted(
    value: unknown
): PersistedLiveCaptionTranslationSettings {
    const fallback = defaults();
    if (!value || typeof value !== 'object') {
        return fallback;
    }
    const raw = value as Partial<PersistedLiveCaptionTranslationSettings>;
    return {
        version: 1,
        enabled: raw.enabled === true,
        provider: 'openai-compatible',
        baseUrl: cleanString(raw.baseUrl, fallback.baseUrl) || fallback.baseUrl,
        model: cleanString(raw.model),
        targetLanguage:
            cleanString(raw.targetLanguage, fallback.targetLanguage) ||
            fallback.targetLanguage,
        ...(typeof raw.encryptedApiKey === 'string' && raw.encryptedApiKey
            ? { encryptedApiKey: raw.encryptedApiKey }
            : {}),
    };
}

/**
 * Dedicated persistent store for live-caption translation.
 *
 * The API key is encrypted using Electron safeStorage (DPAPI on Windows) and
 * never returned to renderer code. This file is intentionally separate from
 * the ordinary Settings object so credentials do not enter settings backup,
 * IndexedDB or the broad renderer->main settings mirror.
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
        const next: PersistedLiveCaptionTranslationSettings = {
            ...current,
            enabled:
                typeof patch.enabled === 'boolean'
                    ? patch.enabled
                    : current.enabled,
            provider: 'openai-compatible',
            baseUrl:
                patch.baseUrl === undefined
                    ? current.baseUrl
                    : cleanString(patch.baseUrl) || DEFAULT_BASE_URL,
            model:
                patch.model === undefined
                    ? current.model
                    : cleanString(patch.model),
            targetLanguage:
                patch.targetLanguage === undefined
                    ? current.targetLanguage
                    : cleanString(patch.targetLanguage) ||
                      DEFAULT_TARGET_LANGUAGE,
        };

        if (patch.clearApiKey === true) {
            delete next.encryptedApiKey;
        }
        if (patch.apiKey !== undefined) {
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

        this.write(next);
        return this.getPublicSettings();
    }

    /** Main-process-only resolved session options, including decrypted key. */
    resolveForSession(): LiveCaptionTranslationOptions | undefined {
        const current = this.read();
        if (!current.enabled) {
            return undefined;
        }
        if (!current.encryptedApiKey) {
            return {
                enabled: true,
                provider: current.provider,
                baseUrl: current.baseUrl,
                model: current.model,
                targetLanguage: current.targetLanguage,
            };
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
            // Corrupt/non-readable credential metadata must not crash caption
            // startup. Fall back to translation disabled and keep source ASR.
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
        fs.renameSync(tempPath, filePath);
    }

    private filePath(): string {
        return path.join(app.getPath('userData'), FILE_NAME);
    }
}

export const liveCaptionTranslationSettingsStore =
    new LiveCaptionTranslationSettingsStore();
