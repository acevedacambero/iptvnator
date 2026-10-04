import type { ResolvedPortalPlayback } from '@iptvnator/shared/interfaces';
import { EmbeddedMpvHlsLoader } from './embedded-mpv-hls-loader';

jest.mock('electron', () => ({ net: {} }));

describe('EmbeddedMpvHlsLoader', () => {
    const playback: ResolvedPortalPlayback = {
        streamUrl: 'https://panel.example/live/channel.m3u8',
        title: 'Live test',
        isLive: true,
    };
    const response = (url: string, ok = true) =>
        ({
            url,
            ok,
            body: { cancel: jest.fn().mockResolvedValue(undefined) },
        }) as unknown as Response;
    const create = () => {
        const fetch = jest.fn();
        const loader = new EmbeddedMpvHlsLoader(fetch);
        loader.register('session', true, []);
        return { fetch, loader, submit: jest.fn() };
    };

    it('uses the redirected base for relative segments while exposing the original source', async () => {
        const { fetch, loader, submit } = create();
        const final = response('https://edge.example/hls/token/index.m3u8');
        fetch.mockResolvedValue(final);
        await loader.load('session', playback, submit);
        const resolved = submit.mock.calls[0][0];
        expect(new URL('segment.ts', resolved.streamUrl).href).toBe(
            'https://edge.example/hls/token/segment.ts'
        );
        expect(new URL('segment.ts', playback.streamUrl).href).not.toBe(
            new URL('segment.ts', resolved.streamUrl).href
        );
        expect(loader.sourceUrl('session', resolved.streamUrl)).toBe(
            playback.streamUrl
        );
        expect(resolved).toEqual({ ...playback, streamUrl: final.url });
        expect(final.body?.cancel).toHaveBeenCalled();
    });

    it('does not let a slow channel overwrite a newer load', async () => {
        const { fetch, loader, submit } = create();
        let finishFirst!: (value: Response) => void;
        fetch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishFirst = resolve;
                })
        );
        const first = loader.load('session', playback, submit);
        const signal = fetch.mock.calls[0][1].signal as AbortSignal;
        const replacement = {
            ...playback,
            streamUrl: 'https://panel.example/other.m3u8',
        };
        fetch.mockResolvedValueOnce(
            response('https://edge.example/other.m3u8')
        );
        await loader.load('session', replacement, submit);
        finishFirst(response('https://edge.example/old.m3u8'));
        await first;
        expect(signal.aborted).toBe(true);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(
            loader.sourceUrl('session', submit.mock.calls[0][0].streamUrl)
        ).toBe(replacement.streamUrl);
    });

    it('does not load after disposal even if fetch ignores cancellation', async () => {
        const { fetch, loader, submit } = create();
        let finish!: (value: Response) => void;
        fetch.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const pending = loader.load('session', playback, submit);
        loader.dispose('session');
        finish(response('https://edge.example/index.m3u8'));
        await pending;
        expect(submit).not.toHaveBeenCalled();
        expect(loader.isResolving('session')).toBe(false);
    });

    it('resolves again on reconnect instead of caching an expiring token', async () => {
        const { fetch, loader, submit } = create();
        fetch.mockResolvedValueOnce(
            response('https://edge.example/first/index.m3u8')
        );
        await loader.load('session', playback, submit);
        fetch.mockResolvedValueOnce(
            response('https://edge.example/second/index.m3u8')
        );
        await loader.load('session', playback, submit);
        expect(submit.mock.calls[1][0].streamUrl).toContain('/second/');
        expect(fetch.mock.calls.map((call) => call[0])).toEqual([
            playback.streamUrl,
            playback.streamUrl,
        ]);
    });

    it.each(['network failure', 'timeout'])(
        'falls back to the source on %s',
        async () => {
            const { fetch, loader, submit } = create();
            fetch.mockRejectedValue(new Error('request failed'));
            await loader.load('session', playback, submit);
            expect(submit).toHaveBeenCalledWith(playback);
            expect(loader.isResolving('session')).toBe(false);
        }
    );

    it.each([
        response('https://edge.example/denied', false),
        response('file:///private'),
    ])('rejects an unusable final response', async (final) => {
        const { fetch, loader, submit } = create();
        fetch.mockResolvedValue(final);
        await loader.load('session', playback, submit);
        expect(submit).toHaveBeenCalledWith(playback);
    });

    it.each([
        'https://panel.example/live.ts',
        'rtsp://camera.example/live',
        'file:///video.mkv',
    ])('does not pre-open %s', (url) => {
        const { fetch, loader, submit } = create();
        const source = { ...playback, streamUrl: url };
        expect(loader.load('session', source, submit)).toBeUndefined();
        expect(submit).toHaveBeenCalledWith(source);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('keeps other engines synchronous and preserves advanced network overrides', () => {
        const { fetch, loader, submit } = create();
        loader.register('session', false, []);
        loader.load('session', playback, submit);
        loader.register('session', true, ['cookies-file=custom.txt']);
        loader.load('session', playback, submit);
        expect(fetch).not.toHaveBeenCalled();
        expect(submit).toHaveBeenCalledTimes(2);
    });

    it('passes source headers and lets source user agent override global settings', async () => {
        const { fetch, loader, submit } = create();
        loader.register('session', true, [
            'user-agent=global',
            'referrer=https://global.example/',
        ]);
        fetch.mockResolvedValue(response(playback.streamUrl));
        await loader.load(
            'session',
            {
                ...playback,
                headers: { 'X-Token': 'test' },
                userAgent: 'source',
                referer: 'https://source.example/',
                origin: 'https://source.example',
            },
            submit
        );
        const headers = fetch.mock.calls[0][1].headers as Headers;
        expect(headers.get('User-Agent')).toBe('source');
        expect(headers.get('Referer')).toBe('https://source.example/');
        expect(headers.get('Origin')).toBe('https://source.example');
        expect(headers.get('X-Token')).toBe('test');
    });
});
