import { NativeSubtitleMpvBridge } from './native-subtitle-mpv-bridge';
import type { MpvJsonIpcClient } from './live-caption/mpv-json-ipc-client';
import { DEFAULT_NATIVE_SUBTITLE_STYLES } from '@iptvnator/shared/interfaces';

describe('private native subtitle bridge', () => {
    it('classifies bitmap tracks and never exposes the raw track filename', async () => {
        const command = jest.fn().mockResolvedValue([
            {
                type: 'sub',
                id: 1,
                codec: 'ass',
                lang: 'eng',
                title: 'English',
                'external-filename': 'private-path',
            },
            { type: 'sub', id: 2, codec: 'hdmv_pgs_subtitle' },
            { type: 'audio', id: 3, codec: 'aac' },
        ]);
        const bridge = new NativeSubtitleMpvBridge({
            command,
        } as unknown as MpvJsonIpcClient);
        const tracks = await bridge.tracks();
        expect(tracks).toHaveLength(2);
        expect(tracks[0].textSupported).toBe(true);
        expect(tracks[1].textSupported).toBe(false);
        expect(JSON.stringify(tracks)).not.toContain('private-path');
    });
    it('hides native rendering but keeps both tracks decoded, using overlay id 2', async () => {
        const command = jest.fn().mockResolvedValue(undefined);
        const bridge = new NativeSubtitleMpvBridge({
            command,
        } as unknown as MpvJsonIpcClient);
        await bridge.select({
            upper: { trackId: 1, style: DEFAULT_NATIVE_SUBTITLE_STYLES.upper },
            lower: { trackId: 2, style: DEFAULT_NATIVE_SUBTITLE_STYLES.lower },
        });
        expect(command.mock.calls.map((call) => call[0])).toEqual([
            ['set_property', 'secondary-sid', 'no'],
            ['set_property', 'sub-visibility', false],
            ['set_property', 'secondary-sub-visibility', false],
            ['set_property', 'sid', 2],
            ['set_property', 'secondary-sid', 1],
        ]);
        await bridge.paint('English\n中文');
        expect(command).toHaveBeenLastCalledWith(
            expect.objectContaining({
                id: 2,
                data: 'English\n中文',
                format: 'ass-events',
            })
        );
    });
    it('treats unavailable text as silence but propagates connection failures', async () => {
        const command = jest
            .fn()
            .mockRejectedValue(
                new Error('MPV command failed: property unavailable')
            );
        const bridge = new NativeSubtitleMpvBridge({
            command,
        } as unknown as MpvJsonIpcClient);
        expect(await bridge.text()).toEqual({ upper: '', lower: '' });
        command.mockRejectedValue(new Error('pipe disconnected'));
        await expect(bridge.text()).rejects.toThrow('pipe disconnected');
    });
});
