import { EmbeddedMpvSubtitlePolicy } from './embedded-mpv-subtitle-policy';
import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';

const live: ResolvedPortalPlayback = {
    streamUrl: 'https://example.test/live.ts',
    title: 'Live',
    isLive: true,
};
const vod: ResolvedPortalPlayback = { ...live, isLive: false };

describe('EmbeddedMpvSubtitlePolicy', () => {
    it('disables tracks for explicit and inferred live sources without mutating the source', () => {
        const policy = new EmbeddedMpvSubtitlePolicy();
        expect(policy.forUserLoad('one', live).subtitleTrackId).toBe(-1);
        expect(
            policy.forUserLoad('two', {
                streamUrl: live.streamUrl,
                title: live.title,
            }).subtitleTrackId
        ).toBe(-1);
        expect(live).not.toHaveProperty('subtitleTrackId');
    });
    it('preserves manual selection on reconnect but resets when changing channels', () => {
        const policy = new EmbeddedMpvSubtitlePolicy();
        policy.forUserLoad('one', live);
        expect(policy.forReload('one', live).subtitleTrackId).toBe(-1);
        policy.selectTrack('one', 3);
        expect(policy.forReload('one', live).subtitleTrackId).toBe(3);
        policy.selectTrack('one', -1);
        expect(policy.forReload('one', live).subtitleTrackId).toBe(-1);
        policy.selectTrack('one', 3);
        expect(
            policy.forUserLoad('one', { ...live, title: 'Next' })
                .subtitleTrackId
        ).toBe(-1);
    });
    it('leaves VOD automatic selection unchanged, including after live in the same session', () => {
        const policy = new EmbeddedMpvSubtitlePolicy();
        policy.forUserLoad('one', live);
        expect(policy.forUserLoad('one', vod)).toBe(vod);
        expect(policy.forReload('one', vod)).toBe(vod);
        expect(
            policy.forUserLoad('two', {
                ...vod,
                isLive: undefined,
                contentInfo: {
                    playlistId: 'p',
                    contentXtreamId: 1,
                    contentType: 'vod',
                },
            })
        ).not.toHaveProperty('subtitleTrackId');
    });
    it('forgets disposed sessions', () => {
        const policy = new EmbeddedMpvSubtitlePolicy();
        policy.forUserLoad('one', live);
        policy.selectTrack('one', 3);
        policy.dispose('one');
        expect(policy.forReload('one', live).subtitleTrackId).toBe(-1);
    });
});
