export interface LiveCaptionPcmWindowOptions {
    sampleRate: number;
    channels: number;
    bytesPerSample: number;
    windowSeconds: number;
    stepSeconds: number;
}

const DEFAULT_OPTIONS: LiveCaptionPcmWindowOptions = {
    sampleRate: 16000,
    channels: 1,
    bytesPerSample: 2,
    windowSeconds: 6,
    stepSeconds: 0.5,
};

function positiveInteger(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be greater than zero.`);
    }
    return Math.max(1, Math.round(value));
}

/**
 * Bounded rolling s16le PCM buffer for streaming ASR.
 *
 * Input arrives in arbitrary stdout chunk sizes. The class emits a snapshot
 * every `stepSeconds` once enough new audio has arrived, while retaining at
 * most `windowSeconds` of history. It never lets a slow recognizer create an
 * unbounded audio queue; callers can simply ignore a snapshot while inference
 * is already in flight and the next snapshot will represent current audio.
 */
export class LiveCaptionPcmWindow {
    readonly bytesPerSecond: number;
    readonly windowBytes: number;
    readonly stepBytes: number;

    private buffer = Buffer.alloc(0);
    private newBytesSinceSnapshot = 0;
    private totalBytesReceived = 0;

    constructor(options: Partial<LiveCaptionPcmWindowOptions> = {}) {
        const resolved = { ...DEFAULT_OPTIONS, ...options };
        const sampleRate = positiveInteger(resolved.sampleRate, 'sampleRate');
        const channels = positiveInteger(resolved.channels, 'channels');
        const bytesPerSample = positiveInteger(
            resolved.bytesPerSample,
            'bytesPerSample'
        );
        if (!Number.isFinite(resolved.windowSeconds) || resolved.windowSeconds <= 0) {
            throw new Error('windowSeconds must be greater than zero.');
        }
        if (!Number.isFinite(resolved.stepSeconds) || resolved.stepSeconds <= 0) {
            throw new Error('stepSeconds must be greater than zero.');
        }
        if (resolved.stepSeconds > resolved.windowSeconds) {
            throw new Error('stepSeconds must not exceed windowSeconds.');
        }

        this.bytesPerSecond = sampleRate * channels * bytesPerSample;
        this.windowBytes = Math.round(
            this.bytesPerSecond * resolved.windowSeconds
        );
        this.stepBytes = Math.round(this.bytesPerSecond * resolved.stepSeconds);
    }

    push(chunk: Buffer): Buffer | null {
        if (chunk.length === 0) {
            return null;
        }
        this.totalBytesReceived += chunk.length;
        this.newBytesSinceSnapshot += chunk.length;
        this.buffer =
            this.buffer.length === 0
                ? Buffer.from(chunk)
                : Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length > this.windowBytes) {
            this.buffer = this.buffer.subarray(
                this.buffer.length - this.windowBytes
            );
        }
        if (this.newBytesSinceSnapshot < this.stepBytes) {
            return null;
        }
        this.newBytesSinceSnapshot %= this.stepBytes;
        return Buffer.from(this.buffer);
    }

    clear(): void {
        this.buffer = Buffer.alloc(0);
        this.newBytesSinceSnapshot = 0;
        this.totalBytesReceived = 0;
    }

    snapshot(): Buffer {
        return Buffer.from(this.buffer);
    }

    get bufferedSeconds(): number {
        return this.buffer.length / this.bytesPerSecond;
    }

    get receivedSeconds(): number {
        return this.totalBytesReceived / this.bytesPerSecond;
    }
}
