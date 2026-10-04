import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveCaptionDisplaySettingsStore } from './live-caption-display-settings.store';
import { DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS } from '@iptvnator/shared/interfaces';

jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));

describe('LiveCaptionDisplaySettingsStore', () => {
    let directory: string;
    let store: LiveCaptionDisplaySettingsStore;
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-style-'));
        store = new LiveCaptionDisplaySettingsStore(() => directory);
    });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    it('persists validated style and positions both lines above the selected margin', () => {
        const settings = {
            ...DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS,
            sourceFontSize: 60,
            translatedFontSize: 80,
            bottomMarginPercent: 20,
        };
        store.update(settings);
        expect(
            new LiveCaptionDisplaySettingsStore(() => directory).get()
        ).toEqual(settings);
        expect(store.getAssStyle()).toEqual({
            sourceFontSize: 60,
            translatedFontSize: 80,
            translatedY: 864,
            sourceY: 764,
            alignment: 'center',
            sourceColor: '#FFFFFF',
            translatedColor: '#FFFFFF',
        });
    });
    it.each([NaN, Infinity, 3, 76, '10', null])(
        'rejects invalid margin %s without overwriting saved settings',
        (margin) => {
            const before = store.get();
            store.update(before);
            expect(() =>
                store.update({ ...before, bottomMarginPercent: margin })
            ).toThrow();
            expect(store.get()).toEqual(before);
        }
    );
    it('reads historical v1 sizes and position without changing the saved file', () => {
        const historical = JSON.stringify({
            version: 1,
            sourceFontSize: 58,
            translatedFontSize: 72,
            bottomMarginPercent: 28,
        });
        const file = path.join(directory, 'live-caption-display.json');
        fs.writeFileSync(file, historical);
        expect(store.get()).toEqual({
            ...DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS,
            sourceFontSize: 58,
            translatedFontSize: 72,
            bottomMarginPercent: 28,
        });
        expect(fs.readFileSync(file, 'utf8')).toBe(historical);
    });
    it('persists separate colors and alignment and keeps large captions inside the upper position', () => {
        const next = store.update({
            ...store.get(),
            sourceFontSize: 96,
            translatedFontSize: 120,
            bottomMarginPercent: 75,
            alignment: 'right',
            sourceColor: '#12abEF',
            translatedColor: '#fFaA00',
        });
        expect(
            new LiveCaptionDisplaySettingsStore(() => directory).get()
        ).toEqual(next);
        expect(store.getAssStyle()).toMatchObject({
            alignment: 'right',
            sourceColor: '#12ABEF',
            translatedColor: '#FFAA00',
            sourceY: 130,
            translatedY: 270,
        });
        expect(
            (store.getAssStyle().sourceY ?? 0) - next.sourceFontSize
        ).toBeGreaterThan(0);
    });
    it.each(['#fff', '#12345678', 'red', '#GG0000', '{\\pos(1,2)}', null])(
        'rejects unsafe or invalid color %s without changing the saved style',
        (color) => {
            const before = store.get();
            store.update(before);
            expect(() =>
                store.update({ ...before, sourceColor: color })
            ).toThrow();
            expect(store.get()).toEqual(before);
        }
    );
    it('rejects unsupported alignment without overwriting settings', () => {
        const before = store.get();
        store.update(before);
        expect(() =>
            store.update({ ...before, alignment: 'outside' })
        ).toThrow();
        expect(store.get()).toEqual(before);
    });
    it('recovers defaults from corrupted or future configuration', () => {
        const before = store.get();
        fs.writeFileSync(
            path.join(directory, 'live-caption-display.json'),
            '{'
        );
        expect(store.get()).toEqual(before);
        fs.writeFileSync(
            path.join(directory, 'live-caption-display.json'),
            '{"version":2}'
        );
        expect(store.get()).toEqual(before);
    });
});
