import { performance } from 'node:perf_hooks';
import type { LiveCaptionSyncTelemetry } from '@iptvnator/shared/interfaces';
import { AiSyncController } from './ai-sync-controller';

interface CaptureClock {
    qpcEnd100ns: number;
    capturedFrames: number;
}

/** Read-only latency measurement. Arrival estimates never claim WASAPI accuracy. */
export class LiveCaptionSyncTracker {
    private readonly sync = new AiSyncController();
    private clock: CaptureClock | null = null;
    private source: 'wasapi' | 'arrival-estimate' | undefined;
    private probeInFlight = false;
    private lastArrivalProbeMs = 0;
    private epoch = 0;

    constructor(
        private readonly position: () => Promise<number | null>,
        private readonly current: () => boolean,
        private readonly changed: () => void
    ) {}

    observeClock(clock: CaptureClock): void {
        if (this.source !== 'wasapi') {
            this.sync.reset();
            this.epoch++;
        }
        this.source = 'wasapi';
        this.clock = clock;
        this.observe(clock.qpcEnd100ns);
    }

    onPcm(receivedFrames: number): void {
        if (this.source === 'wasapi') return;
        const now = performance.now();
        if (now - this.lastArrivalProbeMs < 250) return;
        this.lastArrivalProbeMs = now;
        this.source = 'arrival-estimate';
        this.clock = {
            qpcEnd100ns: now * 10000,
            capturedFrames: receivedFrames,
        };
        this.observe(this.clock.qpcEnd100ns);
    }

    captureEnd(receivedFrames: number): number | null {
        if (!this.clock || receivedFrames < this.clock.capturedFrames)
            return null;
        return (
            this.clock.qpcEnd100ns +
            ((receivedFrames - this.clock.capturedFrames) * 10000000) / 16000
        );
    }

    recordResult(captureEnd: number | null): void {
        if (captureEnd === null) return;
        const epoch = this.epoch;
        void this.position()
            .then((pts) => {
                if (!this.current() || epoch !== this.epoch || pts === null)
                    return;
                if (this.sync.recordCaptionResult(captureEnd, pts) !== null)
                    this.changed();
            })
            .catch(() => undefined);
    }

    snapshot(): LiveCaptionSyncTelemetry {
        return {
            ...this.sync.snapshot(),
            ...(this.source ? { clockSource: this.source } : {}),
        };
    }

    reset(): void {
        this.epoch++;
        this.clock = null;
        this.source = undefined;
        this.sync.reset();
    }

    private observe(qpcEnd100ns: number): void {
        if (this.probeInFlight) return;
        this.probeInFlight = true;
        const epoch = this.epoch;
        void this.position()
            .then((pts) => {
                if (this.current() && epoch === this.epoch && pts !== null)
                    this.sync.observeClock({
                        captureQpc100ns: qpcEnd100ns,
                        mpvPlaybackPtsSeconds: pts,
                    });
            })
            .catch(() => undefined)
            .finally(() => {
                this.probeInFlight = false;
            });
    }
}
