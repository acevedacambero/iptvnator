import { LiveCaptionService } from './live-caption.service';
import { ensureDefaultLiveCaptionModel } from './live-caption-model-manager';
import { liveCaptionRecordingExporter } from './live-caption-recording-exporter';
jest.mock('./live-caption-recording-exporter', () => ({
    liveCaptionRecordingExporter: {
        configure: jest.fn(), forget: jest.fn(), snapshot: () => undefined,
        subscribe: () => jest.fn(), shutdown: jest.fn(),
    },
}));
const mockPipelines: {
    start: jest.Mock;
    stop: jest.Mock;
    snapshot: jest.Mock;
    redraw: jest.Mock;
    setUserPaused: jest.Mock;
}[] = [];
jest.mock('./live-caption-synchronized-session', () => ({
    LiveCaptionSynchronizedSession: jest.fn(() => {
        const pipeline = {
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn().mockResolvedValue(undefined),
            snapshot: jest.fn(() => ({})),
            redraw: jest.fn(),
            setUserPaused: jest.fn(),
        };
        mockPipelines.push(pipeline);
        return pipeline;
    }),
}));
jest.mock('./live-caption-model-manager', () => ({
    ensureDefaultLiveCaptionModel: jest
        .fn()
        .mockResolvedValue('verified-small-model'),
}));
jest.mock('./live-caption-helper-platform.util', () => ({
    resolveLiveCaptionHelperPath: () => 'trusted-helper',
}));
jest.mock('./live-caption-whisper-platform.util', () => ({
    resolveLiveCaptionWhisperHelperPath: () => 'trusted-worker',
    resolveLiveCaptionWhisperModelPath: (explicit?: string) =>
        explicit ?? 'existing-base-model',
}));

describe('live caption session ownership', () => {
    beforeEach(() => {
        mockPipelines.length = 0;
        jest.clearAllMocks();
    });
    function create(): LiveCaptionService {
        const service = new LiveCaptionService();
        jest.spyOn(service, 'getSupport').mockReturnValue({
            supported: true,
            platform: 'win32',
            processLoopbackAvailable: true,
            captureHelperAvailable: true,
            whisperHelperAvailable: true,
            modelConfigured: true,
        });
        return service;
    }
    it('uses the verified quality default even when an older base model exists', async () => {
        const service = create();
        await service.start('session');
        expect(ensureDefaultLiveCaptionModel).toHaveBeenCalledTimes(1);
        expect(mockPipelines[0].start).toHaveBeenCalledWith(
            'verified-small-model',
            {}
        );
        await service.stop();
        expect(liveCaptionRecordingExporter.configure).toHaveBeenCalledWith('session', 'verified-small-model', {});
        expect(liveCaptionRecordingExporter.forget).toHaveBeenCalledWith('session');
    });
    it('retains an explicit model override', async () => {
        const service = create();
        await service.start('session', { modelPath: 'custom-model' });
        expect(ensureDefaultLiveCaptionModel).not.toHaveBeenCalled();
        expect(mockPipelines[0].start).toHaveBeenCalledWith('custom-model', {
            modelPath: 'custom-model',
        });
        await service.stop();
    });
    it('resolves a cancelled Start to the inactive state instead of reporting an error', async () => {
        const service = create();
        // Start creates ownership before the model promise resolves.
        const starting = service.start('session');
        await Promise.resolve();
        let reject!: (error: Error) => void;
        mockPipelines[0].start.mockImplementationOnce(
            () =>
                new Promise((_resolve, failed) => {
                    reject = failed;
                })
        );
        await Promise.resolve();
        await Promise.resolve();
        await service.stop();
        reject(new Error('Worker stopped by cancellation.'));
        await expect(starting).resolves.toMatchObject({
            state: 'inactive',
            active: false,
        });
        expect(service.getState().state).not.toBe('error');
    });
});
