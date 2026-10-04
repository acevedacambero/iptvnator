import { LiveCaptionSyncTracker } from './live-caption-sync-tracker';

describe('LiveCaptionSyncTracker', () => {
    it('labels the fallback estimate when WASAPI supplies no timestamps', async () => {
        const tracker = new LiveCaptionSyncTracker(
            async () => 10,
            () => true,
            () => undefined
        );
        tracker.onPcm(16000);
        await Promise.resolve();
        expect(tracker.snapshot().clockSource).toBe('arrival-estimate');
        expect(tracker.captureEnd(16000)).toBeGreaterThan(0);
    });
    it('replaces the fallback epoch when a genuine capture timestamp arrives', async () => {
        const tracker = new LiveCaptionSyncTracker(
            async () => 10,
            () => true,
            () => undefined
        );
        tracker.onPcm(16000);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        tracker.observeClock({ qpcEnd100ns: 100000000, capturedFrames: 16000 });
        await Promise.resolve();
        expect(tracker.snapshot().clockSource).toBe('wasapi');
        expect(tracker.captureEnd(24000)).toBe(105000000);
    });
    it('ignores a reply from the timeline that was reset', async () => {
        let complete!: (value: number) => void;
        const tracker = new LiveCaptionSyncTracker(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
            () => true,
            () => undefined
        );
        tracker.observeClock({ qpcEnd100ns: 100000000, capturedFrames: 16000 });
        tracker.reset();
        complete(10);
        await Promise.resolve();
        expect(tracker.snapshot().clockAnchorCount).toBe(0);
        expect(tracker.captureEnd(16000)).toBeNull();
    });
});
