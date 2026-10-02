import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('electron', () => ({
    app: {
        getPath: jest.fn(),
    },
    safeStorage: {
        isEncryptionAvailable: jest.fn(),
        encryptString: jest.fn(),
        decryptString: jest.fn(),
    },
}));

import { LiveCaptionTranslationSettingsStore } from './live-caption-translation-settings.store';

interface ElectronMock {
    app: { getPath: jest.Mock };
    safeStorage: {
        isEncryptionAvailable: jest.Mock;
        encryptString: jest.Mock;
        decryptString: jest.Mock;
    };
}

const electron = jest.requireMock('electron') as ElectronMock;

describe('LiveCaptionTranslationSettingsStore', () => {
    let userDataPath = '';
    let store: LiveCaptionTranslationSettingsStore;

    beforeEach(() => {
        userDataPath = fs.mkdtempSync(
            path.join(os.tmpdir(), 'iptvnator-caption-settings-')
        );
        electron.app.getPath.mockReturnValue(userDataPath);
        electron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
        electron.safeStorage.encryptString.mockImplementation((value: string) =>
            Buffer.from(`encrypted:${value}`, 'utf8')
        );
        electron.safeStorage.decryptString.mockImplementation((value: Buffer) =>
            value.toString('utf8').replace(/^encrypted:/, '')
        );
        store = new LiveCaptionTranslationSettingsStore();
    });

    afterEach(() => {
        jest.clearAllMocks();
        fs.rmSync(userDataPath, { recursive: true, force: true });
    });

    it('enables Google free translation without a key or model', () => {
        const publicSettings = store.update({
            enabled: true,
            provider: 'google-free',
            targetLanguage: 'Simplified Chinese',
        });

        expect(publicSettings).toMatchObject({
            enabled: true,
            provider: 'google-free',
            baseUrl: 'https://translate.googleapis.com',
            model: '',
            hasApiKey: false,
        });
        expect(store.resolveForSession()).toMatchObject({
            enabled: true,
            provider: 'google-free',
            baseUrl: 'https://translate.googleapis.com',
            targetLanguage: 'Simplified Chinese',
        });
    });

    it('never returns the plaintext OpenAI-compatible API key to renderer-facing settings', () => {
        const publicSettings = store.update({
            enabled: true,
            provider: 'openai-compatible',
            baseUrl: 'https://example.test/v1',
            model: 'translation-model',
            apiKey: 'top-secret',
        });

        expect(publicSettings.hasApiKey).toBe(true);
        expect(publicSettings).not.toHaveProperty('apiKey');
        expect(JSON.stringify(publicSettings)).not.toContain('top-secret');

        const persisted = fs.readFileSync(
            path.join(userDataPath, 'live-caption-translation.json'),
            'utf8'
        );
        expect(persisted).not.toContain('top-secret');
        expect(persisted).toContain(
            Buffer.from('encrypted:top-secret', 'utf8').toString('base64')
        );
    });

    it('decrypts the key only for main-process OpenAI-compatible session resolution', () => {
        store.update({
            enabled: true,
            provider: 'openai-compatible',
            baseUrl: 'https://example.test/v1',
            model: 'translation-model',
            targetLanguage: 'Simplified Chinese',
            apiKey: 'top-secret',
        });

        expect(store.resolveForSession()).toMatchObject({
            enabled: true,
            provider: 'openai-compatible',
            baseUrl: 'https://example.test/v1',
            model: 'translation-model',
            targetLanguage: 'Simplified Chinese',
            apiKey: 'top-secret',
        });
    });

    it('rejects enabled OpenAI-compatible translation until both model and key are configured', () => {
        expect(() =>
            store.update({
                enabled: true,
                provider: 'openai-compatible',
            })
        ).toThrow('Translation model is required before enabling.');
        expect(() =>
            store.update({
                enabled: true,
                provider: 'openai-compatible',
                model: 'translation-model',
            })
        ).toThrow('Translation API key is required before enabling.');
    });

    it('rejects an enabled OpenAI-compatible endpoint change without a replacement key atomically', () => {
        store.update({
            enabled: true,
            provider: 'openai-compatible',
            baseUrl: 'https://first.example/v1',
            model: 'translation-model',
            apiKey: 'first-secret',
        });

        expect(() =>
            store.update({ baseUrl: 'https://second.example/v1' })
        ).toThrow('Translation API key is required before enabling.');

        expect(store.resolveForSession()).toMatchObject({
            enabled: true,
            baseUrl: 'https://first.example/v1',
            apiKey: 'first-secret',
        });
    });

    it('drops an old key when a disabled keyed configuration changes endpoint', () => {
        store.update({
            enabled: true,
            provider: 'openai-compatible',
            baseUrl: 'https://first.example/v1',
            model: 'translation-model',
            apiKey: 'first-secret',
        });
        store.update({ enabled: false });

        const changed = store.update({
            baseUrl: 'https://second.example/v1',
        });

        expect(changed).toMatchObject({
            enabled: false,
            baseUrl: 'https://second.example/v1',
            hasApiKey: false,
        });
        expect(store.resolveForSession()).toBeUndefined();
    });

    it('accepts a new key atomically with an OpenAI-compatible endpoint change', () => {
        store.update({
            enabled: true,
            provider: 'openai-compatible',
            baseUrl: 'https://first.example/v1',
            model: 'translation-model',
            apiKey: 'first-secret',
        });

        const changed = store.update({
            baseUrl: 'https://second.example/v1',
            apiKey: 'second-secret',
        });

        expect(changed.hasApiKey).toBe(true);
        expect(store.resolveForSession()).toMatchObject({
            baseUrl: 'https://second.example/v1',
            apiKey: 'second-secret',
        });
    });

    it('normalizes incomplete enabled OpenAI-compatible metadata to disabled', () => {
        fs.writeFileSync(
            path.join(userDataPath, 'live-caption-translation.json'),
            `${JSON.stringify({
                version: 1,
                enabled: true,
                provider: 'openai-compatible',
                baseUrl: 'https://example.test/v1',
                model: 'translation-model',
                targetLanguage: 'Simplified Chinese',
            })}\n`,
            'utf8'
        );

        expect(store.getPublicSettings()).toMatchObject({
            enabled: false,
            provider: 'openai-compatible',
            hasApiKey: false,
            model: 'translation-model',
        });
        expect(store.resolveForSession()).toBeUndefined();
    });

    it('falls back to Google translation disabled for corrupt persisted metadata', () => {
        fs.writeFileSync(
            path.join(userDataPath, 'live-caption-translation.json'),
            '{not-json',
            'utf8'
        );

        expect(store.getPublicSettings()).toMatchObject({
            enabled: false,
            provider: 'google-free',
            hasApiKey: false,
            baseUrl: 'https://translate.googleapis.com',
        });
        expect(store.resolveForSession()).toBeUndefined();
    });

    it('does not save an OpenAI-compatible key when secure storage is unavailable', () => {
        electron.safeStorage.isEncryptionAvailable.mockReturnValue(false);

        expect(() =>
            store.update({
                enabled: true,
                provider: 'openai-compatible',
                model: 'translation-model',
                apiKey: 'top-secret',
            })
        ).toThrow('Secure credential storage is unavailable');
    });
});
