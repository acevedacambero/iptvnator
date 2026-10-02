import { AiSyncController } from './ai-sync-controller';

describe('AiSyncController', () => {
    it('maps WASAPI QPC time to MPV PTS with a median-filtered recent offset', () => {
        const sync = new AiSyncController();
        const qpc = 1_000_000_000;

        sync.observeClock({
            captureQpc100ns: qpc,
            mpvPlaybackPtsSeconds: 100.0,
        });
        sync.observeClock({
            captureQpc100ns: qpc + 10_000_000,
            mpvPlaybackPtsSeconds: 101.01,
        });
        // One delayed IPC sample should not drag the clock mapping far away.
        sync.observeClock({
            captureQpc100ns: qpc + 20_000_000,
            mpvPlaybackPtsSeconds: 102.35,
        });

        expect(
            sync.mapCaptureQpcToPlaybackPts(qpc + 30_000_000)
        ).toBeCloseTo(103.01, 2);
    });

    it('measures result lag and reports rolling P50/P95 telemetry', () => {
        const sync = new AiSyncController();
        const qpc = 5_000_000_000;
        sync.observeClock({
            captureQpc100ns: qpc,
            mpvPlaybackPtsSeconds: 50,
        });

        const lags = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
        for (const lagMs of lags) {
            const captureQpc = qpc + 10_000_000;
            const mappedPts = sync.mapCaptureQpcToPlaybackPts(captureQpc);
            expect(mappedPts).not.toBeNull();
            sync.recordCaptionResult(
                captureQpc,
                (mappedPts as number) + lagMs / 1000
            );
        }

        const telemetry = sync.snapshot();
        expect(telemetry.clockAnchorCount).toBe(1);
        expect(telemetry.captionLagSampleCount).toBe(10);
        expect(telemetry.lastCaptionLagMs).toBeCloseTo(1000, 6);
        expect(telemetry.p50CaptionLagMs).toBeCloseTo(500, 6);
        expect(telemetry.p95CaptionLagMs).toBeCloseTo(1000, 6);
    });

    it('retains negative lag during measurement so a bad clock mapping is visible', () => {
        const sync = new AiSyncController();
        const qpc = 2_000_000_000;
        sync.observeClock({
            captureQpc100ns: qpc,
            mpvPlaybackPtsSeconds: 20,
        });

        expect(sync.recordCaptionResult(qpc, 19.9)).toBeCloseTo(-100, 6);
        expect(sync.snapshot().lastCaptionLagMs).toBeCloseTo(-100, 6);
    });

    it('bounds telemetry and resets between playback generations', () => {
        const sync = new AiSyncController(2, 2);
        const qpc = 3_000_000_000;
        sync.observeClock({ captureQpc100ns: qpc, mpvPlaybackPtsSeconds: 30 });
        sync.observeClock({
            captureQpc100ns: qpc + 10_000_000,
            mpvPlaybackPtsSeconds: 31,
        });
        sync.observeClock({
            captureQpc100ns: qpc + 20_000_000,
            mpvPlaybackPtsSeconds: 32,
        });

        for (const lagMs of [100, 200, 300]) {
            const captureQpc = qpc + 20_000_000;
            const mappedPts = sync.mapCaptureQpcToPlaybackPts(captureQpc);
            sync.recordCaptionResult(
                captureQpc,
                (mappedPts as number) + lagMs / 1000
            );
        }
        const telemetry = sync.snapshot();
        expect(telemetry.clockAnchorCount).toBe(2);
        expect(telemetry.captionLagSampleCount).toBe(2);
        expect(telemetry.p50CaptionLagMs).toBeCloseTo(200, 6);
        expect(telemetry.p95CaptionLagMs).toBeCloseTo(300, 6);

        sync.reset();
        expect(sync.mapCaptureQpcToPlaybackPts(qpc)).toBeNull();
        expect(sync.snapshot()).toEqual({
            clockAnchorCount: 0,
            captionLagSampleCount: 0,
        });
    });
});
