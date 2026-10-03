const QPC_100NS_PER_SECOND = 10_000_000;
const DEFAULT_MAX_CLOCK_ANCHORS = 9;
const DEFAULT_MAX_LATENCY_SAMPLES = 120;

export interface AiSyncClockAnchor {
    /** WASAPI capture clock in the 100 ns QPC units returned by GetBuffer. */
    captureQpc100ns: number;
    /** libmpv playback PTS sampled when the capture clock event reaches main. */
    mpvPlaybackPtsSeconds: number;
}

export interface AiSyncTelemetrySnapshot {
    clockAnchorCount: number;
    captionLagSampleCount: number;
    lastCaptionLagMs?: number;
    p50CaptionLagMs?: number;
    p95CaptionLagMs?: number;
}

function finite(value: number): boolean {
    return Number.isFinite(value);
}

function median(values: readonly number[]): number | null {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle];
    }
    return (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: readonly number[], fraction: number): number | null {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * fraction) - 1)
    );
    return sorted[index];
}

function pushBounded(values: number[], value: number, limit: number): void {
    values.push(value);
    if (values.length > limit) {
        values.splice(0, values.length - limit);
    }
}

/**
 * Measurement-only clock mapper for the first synchronization milestone.
 *
 * V2 deliberately measures before adding playback buffering. WASAPI supplies
 * the capture QPC timestamp; libmpv supplies the playback PTS. Recent
 * QPC<->PTS offsets are median-filtered so a slow JSON-IPC reply does not move
 * the mapping permanently. Once ASR returns, the controller measures how far
 * playback has advanced beyond the PTS represented by the newest captured
 * audio. P50/P95 from this class become the input to the later adaptive-buffer
 * decision; this class does not change playback timing itself.
 */
export class AiSyncController {
    private readonly clockOffsetsSeconds: number[] = [];
    private readonly captionLagSamplesMs: number[] = [];
    private lastCaptionLagMs: number | undefined;

    constructor(
        private readonly maxClockAnchors = DEFAULT_MAX_CLOCK_ANCHORS,
        private readonly maxLatencySamples = DEFAULT_MAX_LATENCY_SAMPLES
    ) {
        if (!Number.isInteger(maxClockAnchors) || maxClockAnchors <= 0) {
            throw new Error('maxClockAnchors must be a positive integer.');
        }
        if (!Number.isInteger(maxLatencySamples) || maxLatencySamples <= 0) {
            throw new Error('maxLatencySamples must be a positive integer.');
        }
    }

    observeClock(anchor: AiSyncClockAnchor): void {
        if (
            !finite(anchor.captureQpc100ns) ||
            anchor.captureQpc100ns <= 0 ||
            !finite(anchor.mpvPlaybackPtsSeconds) ||
            anchor.mpvPlaybackPtsSeconds < 0
        ) {
            return;
        }
        const captureSeconds = anchor.captureQpc100ns / QPC_100NS_PER_SECOND;
        pushBounded(
            this.clockOffsetsSeconds,
            anchor.mpvPlaybackPtsSeconds - captureSeconds,
            this.maxClockAnchors
        );
    }

    mapCaptureQpcToPlaybackPts(captureQpc100ns: number): number | null {
        if (!finite(captureQpc100ns) || captureQpc100ns <= 0) {
            return null;
        }
        const offset = median(this.clockOffsetsSeconds);
        if (offset === null) {
            return null;
        }
        return captureQpc100ns / QPC_100NS_PER_SECOND + offset;
    }

    /**
     * Records source-caption delay against the playback clock at ASR result
     * time. Negative values are intentionally retained: during P0 they expose
     * a bad clock mapping instead of being silently clamped away.
     */
    recordCaptionResult(
        captureQpc100ns: number,
        resultPlaybackPtsSeconds: number
    ): number | null {
        if (!finite(resultPlaybackPtsSeconds) || resultPlaybackPtsSeconds < 0) {
            return null;
        }
        const capturedPts = this.mapCaptureQpcToPlaybackPts(captureQpc100ns);
        if (capturedPts === null) {
            return null;
        }
        const lagMs = (resultPlaybackPtsSeconds - capturedPts) * 1000;
        if (!finite(lagMs)) {
            return null;
        }
        this.lastCaptionLagMs = lagMs;
        pushBounded(
            this.captionLagSamplesMs,
            lagMs,
            this.maxLatencySamples
        );
        return lagMs;
    }

    snapshot(): AiSyncTelemetrySnapshot {
        const p50 = percentile(this.captionLagSamplesMs, 0.5);
        const p95 = percentile(this.captionLagSamplesMs, 0.95);
        return {
            clockAnchorCount: this.clockOffsetsSeconds.length,
            captionLagSampleCount: this.captionLagSamplesMs.length,
            ...(this.lastCaptionLagMs !== undefined
                ? { lastCaptionLagMs: this.lastCaptionLagMs }
                : {}),
            ...(p50 !== null ? { p50CaptionLagMs: p50 } : {}),
            ...(p95 !== null ? { p95CaptionLagMs: p95 } : {}),
        };
    }

    reset(): void {
        this.clockOffsetsSeconds.length = 0;
        this.captionLagSamplesMs.length = 0;
        this.lastCaptionLagMs = undefined;
    }
}
