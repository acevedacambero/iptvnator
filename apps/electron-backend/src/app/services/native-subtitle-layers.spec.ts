import {
    DEFAULT_NATIVE_SUBTITLE_STYLES,
    type NativeSubtitleLayers,
} from '@iptvnator/shared/interfaces';
import { NativeSubtitleLayersService } from './native-subtitle-layers.service';
import { buildNativeSubtitleLayerAss } from './native-subtitle-layers-ass';
import type { NativeSubtitleMpvBridge } from './native-subtitle-mpv-bridge';

const layers = (): NativeSubtitleLayers => ({
    upper: { trackId: 1, style: { ...DEFAULT_NATIVE_SUBTITLE_STYLES.upper } },
    lower: { trackId: 2, style: { ...DEFAULT_NATIVE_SUBTITLE_STYLES.lower } },
});
describe('native subtitle layer ownership', () => {
    let service: NativeSubtitleLayersService;
    let bridge: {
        tracks: jest.Mock;
        selection: jest.Mock;
        select: jest.Mock;
        restore: jest.Mock;
        text: jest.Mock;
        paint: jest.Mock;
    };
    beforeEach(() => {
        jest.useFakeTimers();
        bridge = {
            tracks: jest.fn().mockResolvedValue([
                { id: 1, textSupported: true },
                { id: 2, textSupported: true },
                { id: 3, textSupported: false },
            ]),
            selection: jest
                .fn()
                .mockResolvedValue({
                    primary: 2,
                    secondary: false,
                    visible: true,
                    secondaryVisible: true,
                }),
            select: jest.fn().mockResolvedValue(undefined),
            restore: jest.fn().mockResolvedValue(undefined),
            text: jest
                .fn()
                .mockResolvedValue({ upper: 'English', lower: '中文' }),
            paint: jest.fn().mockResolvedValue(undefined),
        };
        service = new NativeSubtitleLayersService(
            () => bridge as unknown as NativeSubtitleMpvBridge
        );
        service.setPlaybackKind('session', true);
    });
    afterEach(() => {
        service.shutdown();
        jest.useRealTimers();
    });
    it('renders two independent styles and restores visibility when disabled', async () => {
        const value = layers();
        value.upper.style.color = '#FFE066';
        value.lower.style.color = '#66D9FF';
        const state = await service.set('session', value, 1);
        expect(state.layers).toEqual(value);
        expect(bridge.paint.mock.calls[0][0]).toContain('pos(960,864)');
        expect(bridge.paint.mock.calls[0][0]).toContain('1c&H0066E0FF&');
        expect(bridge.paint.mock.calls[0][0]).toContain('1c&H00FFD966&');
        await service.set('session', null, 1);
        expect(bridge.paint).toHaveBeenLastCalledWith('');
        expect(bridge.restore).toHaveBeenCalledWith({
            primary: 2,
            secondary: false,
            visible: true,
            secondaryVisible: true,
        });
        await jest.advanceTimersByTimeAsync(120);
        expect(bridge.text).toHaveBeenCalledTimes(1);
    });
    it('rejects invalid, duplicate, bitmap and stale selections without changing playback', async () => {
        await service.set('session', layers(), 1);
        const invalid = layers();
        invalid.lower.style.color = '{bad}';
        await expect(service.set('session', invalid, 1)).rejects.toThrow(
            'color'
        );
        invalid.lower.style.color = '#FFFFFF';
        invalid.lower.trackId = 1;
        await expect(service.set('session', invalid, 1)).rejects.toThrow(
            'different'
        );
        invalid.lower.trackId = 3;
        await expect(service.set('session', invalid, 1)).rejects.toThrow(
            'picture'
        );
        await expect(service.set('session', layers(), 0)).rejects.toThrow(
            'Playback changed'
        );
        expect(bridge.select).toHaveBeenCalledTimes(1);
        expect(bridge.restore).not.toHaveBeenCalled();
    });
    it('serializes source replacement and rejects an old dialog revision', async () => {
        await service.set('session', layers(), 1);
        await service.withPlaybackChange(
            'session',
            true,
            async () => undefined
        );
        await expect(service.set('session', layers(), 1)).rejects.toThrow(
            'Playback changed'
        );
        expect((await service.get('session')).layers).toBeNull();
        expect(bridge.restore).toHaveBeenCalledTimes(1);
        service.setPlaybackKind('session', false);
        await expect(service.get('session')).rejects.toThrow(
            'movie or episode'
        );
    });
    it('clears ended cues, updates seek text and avoids repainting unchanged subtitles', async () => {
        await service.set('session', layers(), 1);
        await jest.advanceTimersByTimeAsync(60);
        expect(bridge.paint).toHaveBeenCalledTimes(1);
        bridge.text.mockResolvedValue({ upper: '', lower: '' });
        await jest.advanceTimersByTimeAsync(60);
        expect(bridge.paint).toHaveBeenLastCalledWith('');
        bridge.text.mockResolvedValue({ upper: 'After seek', lower: '跳转后' });
        await jest.advanceTimersByTimeAsync(60);
        expect(bridge.paint.mock.calls.at(-1)?.[0]).toContain('跳转后');
    });
    it('prevents an in-flight read from painting after source replacement', async () => {
        await service.set('session', layers(), 1);
        let resolve!: (text: { upper: string; lower: string }) => void;
        bridge.text.mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = done;
                })
        );
        await jest.advanceTimersByTimeAsync(60);
        const stopping = service.stop('session');
        await Promise.resolve();
        await Promise.resolve();
        resolve({ upper: 'stale', lower: '旧字幕' });
        await stopping;
        expect(bridge.paint).toHaveBeenCalledTimes(2);
        expect(bridge.paint).toHaveBeenLastCalledWith('');
    });
    it('recovers native visibility if the display pipe fails', async () => {
        await service.set('session', layers(), 1);
        bridge.text.mockRejectedValueOnce(new Error('pipe disconnected'));
        await jest.advanceTimersByTimeAsync(60);
        expect(bridge.restore).toHaveBeenCalledTimes(1);
        expect((await service.get('session')).error).toContain('stopped');
        expect((await service.get('session')).layers).toBeNull();
    });
});
describe('native subtitle ASS text', () => {
    it('escapes embedded tags and preserves subtitle line breaks', () => {
        const ass = buildNativeSubtitleLayerAss(
            layers(),
            '{\\pos(0,0)}\nEnglish',
            '中文'
        );
        expect(ass).toContain('\\{');
        expect(ass).toContain('\\NEnglish');
        expect(ass.split('\n')).toHaveLength(2);
    });
    it('omits disabled tracks and expired text', () => {
        const value = layers();
        value.upper.trackId = null;
        expect(buildNativeSubtitleLayerAss(value, 'ignored', '')).toBe('');
    });
});
