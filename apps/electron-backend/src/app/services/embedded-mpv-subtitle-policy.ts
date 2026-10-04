import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';
import { isLiveEmbeddedMpvPlayback } from './embedded-mpv-reconnect';

/** Main-process-only, file-scoped hint; never a global mpv option. */
export interface NativeEmbeddedMpvPlayback extends ResolvedPortalPlayback {
    subtitleTrackId?: number;
}

/** New live sources start muted; reconnect keeps the user's track choice. */
export class EmbeddedMpvSubtitlePolicy {
    private readonly liveTracks = new Map<string, number>();

    forUserLoad(
        sessionId: string,
        playback: ResolvedPortalPlayback
    ): NativeEmbeddedMpvPlayback {
        this.liveTracks.delete(sessionId);
        if (!isLiveEmbeddedMpvPlayback(playback)) return playback;
        this.liveTracks.set(sessionId, -1);
        return { ...playback, subtitleTrackId: -1 };
    }

    forReload(
        sessionId: string,
        playback: ResolvedPortalPlayback
    ): NativeEmbeddedMpvPlayback {
        return isLiveEmbeddedMpvPlayback(playback)
            ? {
                  ...playback,
                  subtitleTrackId: this.liveTracks.get(sessionId) ?? -1,
              }
            : playback;
    }

    selectTrack(sessionId: string, trackId: number): void {
        if (this.liveTracks.has(sessionId))
            this.liveTracks.set(sessionId, trackId);
    }

    dispose(sessionId: string): void {
        this.liveTracks.delete(sessionId);
    }
}
