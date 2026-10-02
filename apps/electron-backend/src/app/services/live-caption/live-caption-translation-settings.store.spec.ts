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

    it('never returns the plaintext API key to renderer-facing settings', () => {
        const publicSettings = store.update({
            enabled: true,
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

    it('decrypts the key only for main-process session resolution', () => {
        store.update({
            enabled: true,
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

    it('drops an old key when the provider endpoint changes', () => {
        store.update({
            enabled: true,
            baseUrl: 'https://first.example/v1',
            model: 'translation-model',
            apiKey: 'first-secret',
        });

        const changed = store.update({
            baseUrl: 'https://second.example/v1',
        });

        expect(changed.baseUrl).toBe('https://second.example/v1');
        expect(changed.hasApiKey).toBe(false);
        expect(store.resolveForSession()).toMatchObject({
            enabled: true,
            baseUrl: 'https://second.example/v1',
        });
        expect(store.resolveForSession()).not.toHaveProperty('apiKey');
    });

    it('accepts a new key atomically with an endpoint change', () => {
        store.update({
            enabled: true,
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

    it('falls back to translation disabled for corrupt persisted metadata', () => {
        fs.writeFileSync(
            path.join(userDataPath, 'live-caption-translation.json'),
            '{not-json',
            'utf8'
        );

        expect(store.getPublicSettings()).toMatchObject({
            enabled: false,
            hasApiKey: false,
            baseUrl: 'https://api.openai.com/v1',
        });
        expect(store.resolveForSession()).toBeUndefined();
    });

    it('does not save a key when secure storage is unavailable', () => {
        electron.safeStorage.isEncryptionAvailable.mockReturnValue(false);

        expect(() =>
            store.update({
                enabled: true,
                model: 'translation-model',
                apiKey: 'top-secret',
            })
        ).toThrow('Secure credential storage is unavailable');
    });
});
