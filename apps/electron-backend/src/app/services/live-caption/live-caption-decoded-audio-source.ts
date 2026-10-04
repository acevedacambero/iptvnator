import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, Server, Socket } from 'node:net';
import { resolveLiveCaptionHelperPath } from './live-caption-helper-platform.util';
import { findCaptionPcmFrame } from './live-caption-pcm-checksum';

export interface CaptionAudioFrame {
    pcm: Buffer;
    pts: number;
    end: number;
}
interface AudioStamp {
    pts: number;
    samples: number;
    checksum: number;
}

/** Joins libavfilter frame timestamps with its separate raw PCM pipe. */
export class CaptionAudioFrameReader {
    private pcm = Buffer.alloc(0);
    private stamps: AudioStamp[] = [];
    get empty(): boolean {
        return this.stamps.length === 0 && this.pcm.length === 0;
    }
    pushPcm(chunk: Buffer): CaptionAudioFrame[] {
        this.pcm = Buffer.concat([this.pcm, chunk]);
        if (this.pcm.length > 2_000_000)
            throw new Error('Caption audio pipe exceeded its bounded buffer.');
        return this.drain();
    }
    pushStamp(value: unknown): CaptionAudioFrame[] {
        const stamp = value as Partial<AudioStamp> | null;
        if (
            !stamp ||
            !Number.isFinite(stamp.pts) ||
            !Number.isInteger(stamp.samples) ||
            (stamp.samples ?? 0) <= 0 ||
            (stamp.samples ?? 0) > 16000 ||
            !Number.isInteger(stamp.checksum) ||
            (stamp.checksum ?? -1) < 0 ||
            (stamp.checksum ?? Infinity) > 0xffffffff
        )
            throw new Error('Invalid decoded audio timestamp.');
        this.stamps.push(stamp as AudioStamp);
        if (this.stamps.length > 600)
            throw new Error(
                'Caption timestamps exceeded their bounded buffer.'
            );
        return this.drain();
    }
    private drain(): CaptionAudioFrame[] {
        const frames: CaptionAudioFrame[] = [];
        while (
            this.stamps.length &&
            this.pcm.length >= this.stamps[0].samples * 2
        ) {
            const stamp = this.stamps[0];
            if (!stamp) break;
            const bytes = stamp.samples * 2;
            const offset = findCaptionPcmFrame(this.pcm, bytes, stamp.checksum);
            if (offset === null) {
                if (this.pcm.length >= bytes + 32000)
                    throw new Error(
                        'Caption audio does not match its media timestamp.'
                    );
                break;
            }
            this.stamps.shift();
            frames.push({
                pcm: Buffer.from(this.pcm.subarray(offset, offset + bytes)),
                pts: stamp.pts,
                end: stamp.pts + stamp.samples / 16000,
            });
            this.pcm = this.pcm.subarray(offset + bytes);
        }
        return frames;
    }
    finish(): void {
        if (!this.empty)
            throw new Error(
                'Caption audio ended without matching media timestamps.'
            );
    }
}

export class LiveCaptionDecodedAudioSource {
    private child: ChildProcess | null = null;
    private server: Server | null = null;
    private socket: Socket | null = null;
    private paused = false;
    private stopped = true;
    private ended = false;

    async start(
        context: {
            source: string;
            position: number;
            origin: number;
            aid: string;
            userAgent: string;
            referrer: string;
            headers: string;
        },
        onFrame: (frame: CaptionAudioFrame) => void,
        onError: (error: Error) => void,
        onEnd: () => void
    ): Promise<void> {
        const helper = resolveLiveCaptionHelperPath();
        if (!helper) throw new Error('The caption audio decoder is missing.');
        const lines = [
            context.source,
            context.userAgent,
            context.referrer,
            context.headers,
        ];
        if (lines.some((line) => /[\r\n\0]/.test(line)))
            throw new Error('Invalid caption source options.');
        this.stopped = false;
        this.ended = false;
        const reader = new CaptionAudioFrameReader();
        const guard = (action: () => void) => {
            if (this.stopped) return;
            try {
                action();
            } catch (error) {
                onError(
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        };
        let endDelivered = false;
        let socketEnded = false;
        const deliver = (frames: CaptionAudioFrame[]) => {
            frames.forEach(onFrame);
            if (this.ended && socketEnded) reader.finish();
            if (this.ended && reader.empty && !endDelivered) {
                endDelivered = true;
                onEnd();
            }
        };
        const pipe = `\\\\.\\pipe\\iptvnator-caption-pcm-${process.pid}-${randomUUID()}`;
        const server = createServer((socket) => {
            if (this.socket || this.stopped) {
                socket.destroy();
                return;
            }
            this.socket = socket;
            socket.on('end', () =>
                guard(() => {
                    socketEnded = true;
                    deliver([]);
                })
            );
            socket.on('data', (chunk) =>
                guard(() => deliver(reader.pushPcm(chunk)))
            );
            socket.on('error', () =>
                guard(() => onError(new Error('Caption PCM pipe failed.')))
            );
        });
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(pipe, resolve);
        });
        if (this.stopped) {
            server.close();
            return;
        }
        const child = spawn(
            helper,
            [
                '--decode',
                pipe,
                String(context.origin + context.position),
                context.aid,
            ],
            { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }
        );
        this.child = child;
        let pending = '';
        let ended = false;
        child.stderr?.on('data', (chunk) =>
            guard(() => {
                pending += chunk.toString();
                if (pending.length > 65536)
                    throw new Error('Caption decoder protocol overflow.');
                const lines = pending.split('\n');
                pending = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const event = JSON.parse(line);
                    if (event.event === 'frame')
                        deliver(reader.pushStamp(event));
                    if (event.event === 'end') {
                        ended = true;
                        if (event.error < 0)
                            onError(
                                new Error('Caption source decoding failed.')
                            );
                        else {
                            this.ended = true;
                            deliver([]);
                        }
                    }
                }
            })
        );
        child.on('error', () =>
            guard(() => onError(new Error('Caption decoder could not start.')))
        );
        child.on('exit', (code) =>
            guard(() => {
                if (!ended)
                    onError(
                        new Error(
                            `Caption decoder stopped unexpectedly (${code ?? 'signal'}).`
                        )
                    );
            })
        );
        child.stdin?.on('error', () =>
            guard(() =>
                onError(new Error('Caption decoder control pipe failed.'))
            )
        );
        child.stdin?.write(lines.join('\n') + '\n');
    }

    setPaused(paused: boolean): void {
        if (this.stopped || this.paused === paused) return;
        this.paused = paused;
        if (!this.ended && this.child?.exitCode === null)
            this.child.stdin?.write(paused ? 'pause\n' : 'resume\n');
        if (paused) this.socket?.pause();
        else this.socket?.resume();
    }
    stop(): void {
        this.stopped = true;
        this.socket?.destroy();
        this.socket = null;
        this.server?.close();
        this.server = null;
        this.child?.kill();
        this.child = null;
    }
}
