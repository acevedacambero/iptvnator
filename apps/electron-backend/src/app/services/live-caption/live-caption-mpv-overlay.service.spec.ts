import { MpvJsonIpcClient } from './mpv-json-ipc-client';
import { LiveCaptionMpvOverlayService } from './live-caption-mpv-overlay.service';

jest.mock('./mpv-json-ipc-client');

describe('MPV caption clock', () => {
    it('uses positional IPC get_property arguments, keeping the pipe private', async () => {
        const command = jest
            .spyOn(MpvJsonIpcClient.prototype, 'command')
            .mockResolvedValue(12.5);
        const service = new LiveCaptionMpvOverlayService();
        service.registerSession('session', 'private-pipe');
        expect(await service.getPlaybackPositionSeconds('session')).toBe(12.5);
        expect(command).toHaveBeenCalledWith(['get_property', 'time-pos']);
        service.shutdown();
    });
    it('keeps source PTS when playback uses a rebased live timeline', async () => {
        const values: Record<string, unknown> = {
            'stream-open-filename': 'https://example.test/live.m3u8',
            'demuxer-start-time': 4000,
            'time-pos': 30,
            aid: 2,
            'user-agent': 'IPTVnator',
            referrer: '',
            'http-header-fields': [],
            pause: false,
            'rebase-start-time': true,
        };
        jest.spyOn(MpvJsonIpcClient.prototype, 'command').mockImplementation(
            async (command) => values[(command as string[])[1]]
        );
        const service = new LiveCaptionMpvOverlayService();
        service.registerSession('session', 'private-pipe');
        expect(
            await service.getCaptionPlaybackContext('session')
        ).toMatchObject({ origin: 4000, position: 30, aid: '2' });
        values['rebase-start-time'] = false;
        expect(
            (await service.getCaptionPlaybackContext('session')).origin
        ).toBe(0);
        service.shutdown();
    });
    it('does not substitute wall time when source timing is unavailable', async () => {
        jest.spyOn(MpvJsonIpcClient.prototype, 'command').mockResolvedValue(
            null
        );
        const service = new LiveCaptionMpvOverlayService();
        service.registerSession('session', 'private-pipe');
        await expect(
            service.getCaptionPlaybackContext('session')
        ).rejects.toThrow('media clock');
        await expect(
            service.alignCaptionPlayback('session', NaN)
        ).rejects.toThrow('position');
        service.shutdown();
    });
});
