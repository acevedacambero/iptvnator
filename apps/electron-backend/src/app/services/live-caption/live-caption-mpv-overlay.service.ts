import { randomUUID } from 'node:crypto';
import { EmbeddedMpvAiCaptionOverlay } from '@iptvnator/shared/interfaces';
import { MpvJsonIpcClient } from './mpv-json-ipc-client';

const AI_CAPTION_OVERLAY_ID = 1;

interface SessionOverlayRuntime {
    pipePath: string;
    client: MpvJsonIpcClient | null;
}

function normalizeDimension(value: number | undefined, fallback: number): number {
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
        const assEvents = typeof overlay.assEvents === 'string' ? overlay.assEvents : '';
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
    async getPlaybackPositionSeconds(sessionId: string): Promise<number | null> {
        const runtime = this.sessions.get(sessionId);
        if (!runtime) {
            return null;
        }
        const value = await this.getClient(runtime).command({
            _name: 'get_property',
            name: 'time-pos',
        });
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
