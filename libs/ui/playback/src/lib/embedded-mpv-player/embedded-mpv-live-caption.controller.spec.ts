import { EmbeddedMpvLiveCaptionController } from './embedded-mpv-live-caption.controller';

describe('EmbeddedMpvLiveCaptionController', () => {
    const inactive = { state: 'inactive', active: false, generation: 0 };
    const api = {
        getSupport: jest.fn().mockResolvedValue({ supported: true }),
        getState: jest.fn().mockResolvedValue(inactive),
        onStateChanged: jest.fn().mockReturnValue(jest.fn()),
        start: jest.fn(),
        stop: jest.fn().mockResolvedValue(inactive),
    };
    let controller: EmbeddedMpvLiveCaptionController;
    beforeEach(async () => {
        jest.clearAllMocks();
        Object.defineProperty(window, 'liveCaptions', {
            configurable: true,
            value: api,
        });
        controller = new EmbeddedMpvLiveCaptionController();
        await Promise.resolve();
        await Promise.resolve();
    });
    afterEach(() => {
        controller.dispose();
        Reflect.deleteProperty(window, 'liveCaptions');
    });
    it('allows cancellation during model startup and ignores the old Start reply', async () => {
        let finish!: (value: unknown) => void;
        api.start.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const starting = controller.toggle('session');
        expect(controller.starting()).toBe(true);
        await controller.toggle('session');
        expect(api.stop).toHaveBeenCalledWith('session');
        expect(controller.active()).toBe(false);
        finish({ state: 'running', active: true, generation: 1 });
        await starting;
        expect(controller.active()).toBe(false);
    });
    it('explains synchronized playback buffering and leaves Stop available', async () => {
        controller.state.set({
            state: 'running',
            active: true,
            generation: 1,
            syncTelemetry: {
                clockSource: 'media-pts',
                clockAnchorCount: 1,
                captionLagSampleCount: 0,
                buffering: true,
            },
        });
        expect(controller.starting()).toBe(true);
        expect(controller.tooltip()).toContain('buffering');
        await controller.toggle('session');
        expect(api.stop).toHaveBeenCalledWith('session');
    });
});
