import { randomUUID } from 'node:crypto';
import { EmbeddedMpvAiCaptionOverlay } from '@iptvnator/shared/interfaces';
import { MpvJsonIpcClient } from './mpv-json-ipc-client';
import { NativeSubtitleMpvBridge } from '../native-subtitle-mpv-bridge';

const AI_CAPTION_OVERLAY_ID = 1;

interface SessionOverlayRuntime {
    pipePath: string;
    client: MpvJsonIpcClient | null;
}

function normalizeDimension(
    value: number | undefined,
    fallback: number
): number {
    return Number.isFinite(value) && (value ?? 0) > 0
        ? Math.round(value as number)
        : fallback;
}

function normalizeZ(value: number | undefined): number {
    return Number.isFinite(value) ? Math.round(value as number) : 50;
}

/**
 * Owns the private MPV JSON-IPC pipe used by the Windows native-view AI
 * caption overlay. It is intentionally main-process scoped and never exposed
 * to the renderer: mpv's IPC protocol can execute powerful commands, so only
 * this narrow service may write to the pipe.
 */
export class LiveCaptionMpvOverlayService {
    private readonly sessions = new Map<string, SessionOverlayRuntime>();

    nativeSubtitleBridge(sessionId: string): NativeSubtitleMpvBridge {
        return new NativeSubtitleMpvBridge(this.getClient(this.getRuntime(sessionId)));
    }

    /**
     * Allocates the pipe before libmpv is initialized so the path can be
     * supplied as the init-only `input-ipc-server` option.
     */
    createPipePath(): string {
        return `\\\\.\\pipe\\iptvnator-ai-caption-${process.pid}-${randomUUID()}`;
    }

    registerSession(sessionId: string, pipePath: string): void {
        this.disposeSession(sessionId);
        this.sessions.set(sessionId, { pipePath, client: null });
    }

    async setOverlay(
        sessionId: string,
        overlay: EmbeddedMpvAiCaptionOverlay
    ): Promise<void> {
        const runtime = this.getRuntime(sessionId);
        const client = this.getClient(runtime);
        const assEvents =
            typeof overlay.assEvents === 'string' ? overlay.assEvents : '';
        if (!assEvents) {
            await this.clearOverlay(sessionId);
            return;
        }

        await client.command({
            _name: 'osd-overlay',
            id: AI_CAPTION_OVERLAY_ID,
            format: 'ass-events',
            data: assEvents,
            res_x: normalizeDimension(overlay.playResX, 1920),
            res_y: normalizeDimension(overlay.playResY, 1080),
            z: normalizeZ(overlay.z),
        });
    }

    /**
     * Narrow read-only clock probe used by AISyncController. Keeping the MPV
     * query here preserves the security boundary: renderer code still never
     * receives access to the general JSON-IPC pipe.
     */
    async getPlaybackPositionSeconds(
        sessionId: string
    ): Promise<number | null> {
        const runtime = this.sessions.get(sessionId);
        if (!runtime) {
            return null;
        }
        // get_property is an IPC command, so it requires positional arguments.
        const value = await this.getClient(runtime).command([
            'get_property',
            'time-pos',
        ]);
        return typeof value === 'number' && Number.isFinite(value) && value >= 0
            ? value
            : null;
    }

    async clearOverlay(sessionId: string): Promise<void> {
        const runtime = this.sessions.get(sessionId);
        if (!runtime) {
            return;
        }
        const client = this.getClient(runtime);
        await client.command({
            _name: 'osd-overlay',
            id: AI_CAPTION_OVERLAY_ID,
            format: 'none',
            data: '',
        });
    }

    async getCaptionPlaybackContext(sessionId: string): Promise<{
        source: string;
        origin: number;
        position: number;
        aid: string;
        userAgent: string;
        referrer: string;
        headers: string;
        paused: boolean;
    }> {
        const client = this.getClient(this.getRuntime(sessionId));
        const read = (name: string) => client.command(['get_property', name]);
        const values = await Promise.all(
            [
                'stream-open-filename',
                'demuxer-start-time',
                'time-pos',
                'aid',
                'user-agent',
                'referrer',
                'http-header-fields',
                'pause',
                'rebase-start-time',
            ].map(read)
        );
        const [
            source,
            start,
            position,
            aid,
            userAgent,
            referrer,
            headers,
            paused,
            rebase,
        ] = values;
        if (
            typeof source !== 'string' ||
            !source ||
            typeof start !== 'number' ||
            typeof position !== 'number' ||
            !Number.isFinite(start + position)
        )
            throw new Error(
                'The player has no valid media clock for synchronized captions.'
            );
        return {
            source,
            origin: rebase === false ? 0 : start,
            position,
            aid: typeof aid === 'number' ? String(aid) : 'auto',
            userAgent: typeof userAgent === 'string' ? userAgent : '',
            referrer: typeof referrer === 'string' ? referrer : '',
            headers: Array.isArray(headers)
                ? headers.map(String).join(',')
                : '',
            paused: paused === true,
        };
    }

    async setCaptionBuffering(
        sessionId: string,
        paused: boolean
    ): Promise<void> {
        await this.getClient(this.getRuntime(sessionId)).command([
            'set_property',
            'pause',
            paused,
        ]);
    }

    async alignCaptionPlayback(
        sessionId: string,
        position: number
    ): Promise<void> {
        if (!Number.isFinite(position) || position < 0)
            throw new Error('Invalid caption media position.');
        await this.getClient(this.getRuntime(sessionId)).command([
            'seek',
            position,
            'absolute+exact',
        ]);
    }

    disposeSession(sessionId: string): void {
        const runtime = this.sessions.get(sessionId);
        this.sessions.delete(sessionId);
        runtime?.client?.close();
    }

    shutdown(): void {
        for (const sessionId of [...this.sessions.keys()]) {
            this.disposeSession(sessionId);
        }
    }

    private getRuntime(sessionId: string): SessionOverlayRuntime {
        const runtime = this.sessions.get(sessionId);
        if (!runtime) {
            throw new Error(
                `AI caption IPC pipe is not registered for embedded MPV session ${sessionId}.`
            );
        }
        return runtime;
    }

    private getClient(runtime: SessionOverlayRuntime): MpvJsonIpcClient {
        if (!runtime.client) {
            runtime.client = new MpvJsonIpcClient(runtime.pipePath);
        }
        return runtime.client;
    }
}

export const liveCaptionMpvOverlayService = new LiveCaptionMpvOverlayService();
