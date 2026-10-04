import { LiveCaptionLinePresenter } from './live-caption-line-presenter';
import { liveCaptionMpvOverlayService } from './live-caption-mpv-overlay.service';
import { liveCaptionDisplaySettingsStore } from './live-caption-display-settings.store';

jest.mock('./live-caption-mpv-overlay.service', () => ({
    liveCaptionMpvOverlayService: {
        setOverlay: jest.fn().mockResolvedValue(undefined),
        clearOverlay: jest.fn().mockResolvedValue(undefined),
    },
}));
jest.mock('./live-caption-display-settings.store', () => ({
    liveCaptionDisplaySettingsStore: { getAssStyle: jest.fn(() => ({})) },
}));
jest.mock('./live-caption-translation-settings.store', () => ({
    liveCaptionTranslationSettingsStore: { resolveForSession: jest.fn() },
}));

const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('LiveCaptionLinePresenter', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
        jest.clearAllMocks();
    });

    it('never puts a late translation on the next English line', async () => {
        let resolve!: (value: unknown) => void;
        globalThis.fetch = jest.fn(
            () =>
                new Promise((done) => {
                    resolve = done;
                })
        ) as typeof fetch;
        const presenter = new LiveCaptionLinePresenter(
            'session',
            { enabled: true, provider: 'google-free' },
            () => true,
            () => undefined
        );
        await presenter.commit('First line.');
        await presenter.commit('Second line.');
        resolve({ ok: true, json: async () => [[['旧翻译']]] });
        await flush();
        expect(presenter.snapshot().lastText).toBe('Second line.');
        expect(presenter.snapshot().lastTranslatedText).toBeUndefined();
        expect(
            jest
                .mocked(liveCaptionMpvOverlayService.setOverlay)
                .mock.calls.every(
                    ([, overlay]) => !overlay.assEvents.includes('旧翻译')
                )
        ).toBe(true);
        presenter.dispose();
    });

    it('keeps English on translation failure and redraws active text without restarting capture', async () => {
        globalThis.fetch = jest
            .fn()
            .mockRejectedValue(new Error('offline')) as typeof fetch;
        const presenter = new LiveCaptionLinePresenter(
            'session',
            { enabled: true, provider: 'google-free' },
            () => true,
            () => undefined
        );
        await presenter.commit('Still visible.');
        await flush();
        expect(presenter.snapshot()).toMatchObject({
            lastText: 'Still visible.',
            translationError: 'offline',
        });
        jest.mocked(
            liveCaptionDisplaySettingsStore.getAssStyle
        ).mockReturnValue({ sourceFontSize: 70 });
        await presenter.redraw();
        expect(
            jest
                .mocked(liveCaptionMpvOverlayService.setOverlay)
                .mock.calls.at(-1)?.[1].assEvents
        ).toContain('\\fs70');
        presenter.dispose();
    });
});
