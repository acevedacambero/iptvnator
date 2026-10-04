import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';
import { requestHlsRedirect } from './embedded-mpv-hls-redirect';

type FetchPlaylist = (
    url: string,
    init: RequestInit
) => Promise<
    Pick<Response, 'ok' | 'url'> & { body?: ReadableStream<Uint8Array> }
>;
interface SessionLoad {
    enabled: boolean;
    options: string[];
    pending?: AbortController;
    originalUrl?: string;
    resolvedUrl?: string;
}

/**
 * Recent libmpv versions reuse the first HLS manifest without propagating its
 * HTTP redirect URL to FFmpeg. Relative segments then use the original base
 * and fail until a playlist refresh. Resolve the base before handing it to mpv,
 * while retaining the source URL for reconnect, diagnostics and persistence.
 */
export class EmbeddedMpvHlsLoader {
    private readonly sessions = new Map<string, SessionLoad>();

    constructor(
        private readonly fetchPlaylist: FetchPlaylist = requestHlsRedirect
    ) {}

    register(sessionId: string, enabled: boolean, options: string[]): void {
        this.sessions.set(sessionId, { enabled, options });
    }

    dispose(sessionId: string): void {
        this.cancel(sessionId);
        this.sessions.delete(sessionId);
    }

    cancel(sessionId: string): void {
        const state = this.sessions.get(sessionId);
        state?.pending?.abort();
        if (state) state.pending = undefined;
    }

    isResolving(sessionId: string): boolean {
        return !!this.sessions.get(sessionId)?.pending;
    }

    sourceUrl(sessionId: string, engineUrl: string): string {
        const state = this.sessions.get(sessionId);
        return state?.pending || engineUrl === state?.resolvedUrl
            ? (state?.originalUrl ?? engineUrl)
            : engineUrl;
    }

    load(
        sessionId: string,
        playback: ResolvedPortalPlayback,
        submit: (playback: ResolvedPortalPlayback) => void
    ): void | Promise<void> {
        const state = this.sessions.get(sessionId);
        state?.pending?.abort();
        if (state) state.pending = undefined;
        if (
            !state?.enabled ||
            !this.canResolve(playback.streamUrl, state.options)
        ) {
            if (state) {
                state.originalUrl = undefined;
                state.resolvedUrl = undefined;
            }
            submit(playback);
            return;
        }
        const controller = new AbortController();
        state.pending = controller;
        state.originalUrl = playback.streamUrl;
        state.resolvedUrl = undefined;
        return this.resolve(playback, state.options, controller.signal).then(
            (resolved) => {
                if (state.pending !== controller || controller.signal.aborted)
                    return;
                state.pending = undefined;
                state.resolvedUrl = resolved.streamUrl;
                submit(resolved);
            }
        );
    }

    private canResolve(url: string, options: string[]): boolean {
        try {
            const parsed = new URL(url);
            // Avoid pre-opening continuous TS streams or non-network files.
            if (
                !/^https?:$/.test(parsed.protocol) ||
                !/\.m3u8$/i.test(parsed.pathname)
            )
                return false;
        } catch {
            return false;
        }
        // These advanced settings cannot be reproduced by Electron fetch.
        // Let mpv own the request rather than silently changing their meaning.
        return !options.some((line) =>
            /^(http-header-fields|http-proxy|cookies(?:-file)?|tls-[^=]+|stream-lavf-o)=/i.test(
                line
            )
        );
    }

    private async resolve(
        playback: ResolvedPortalPlayback,
        options: string[],
        signal: AbortSignal
    ): Promise<ResolvedPortalPlayback> {
        try {
            const headers = new Headers({ 'User-Agent': 'libmpv' });
            for (const line of options) {
                const split = line.indexOf('=');
                const key = line.slice(0, split);
                if (key === 'user-agent')
                    headers.set('User-Agent', line.slice(split + 1));
                if (key === 'referrer')
                    headers.set('Referer', line.slice(split + 1));
            }
            for (const [name, value] of Object.entries(playback.headers ?? {}))
                headers.set(name, value);
            if (playback.userAgent)
                headers.set('User-Agent', playback.userAgent);
            if (playback.referer) headers.set('Referer', playback.referer);
            if (playback.origin) headers.set('Origin', playback.origin);
            const response = await this.fetchPlaylist(playback.streamUrl, {
                headers,
                redirect: 'follow',
                signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
            });
            // Headers suffice; do not consume the playlist or media bytes.
            await response.body?.cancel();
            if (response.ok && /^https?:\/\//i.test(response.url)) {
                return { ...playback, streamUrl: response.url };
            }
        } catch {
            // Preserve ordinary mpv error handling on timeout/network failure.
            // Never log either URL: redirects often contain access tokens.
        }
        return playback;
    }
}
