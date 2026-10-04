import { EventEmitter } from 'node:events';
import { requestHlsRedirect } from './embedded-mpv-hls-redirect';

const mockRequest = jest.fn();
jest.mock('electron', () => ({
    net: { request: (...args: unknown[]) => mockRequest(...args) },
}));

describe('requestHlsRedirect', () => {
    function create() {
        const request = Object.assign(new EventEmitter(), {
            followRedirect: jest.fn(),
            abort: jest.fn(),
            end: jest.fn(),
            setHeader: jest.fn(),
        });
        mockRequest.mockReturnValue(request);
        return request;
    }

    it('uses redirect events because net.fetch Response.url retains the input URL', async () => {
        const request = create();
        const pending = requestHlsRedirect('https://source.example/live.m3u8', {
            headers: { 'User-Agent': 'source' },
        });
        request.emit(
            'redirect',
            302,
            'GET',
            'https://edge.example/token/index.m3u8',
            {}
        );
        expect(request.followRedirect).toHaveBeenCalledTimes(1);
        request.emit('response', { statusCode: 200 });
        await expect(pending).resolves.toEqual({
            ok: true,
            url: 'https://edge.example/token/index.m3u8',
        });
        expect(request.setHeader).toHaveBeenCalledWith('user-agent', 'source');
        expect(request.abort).toHaveBeenCalledTimes(1);
    });

    it('aborts outstanding requests when the session is cancelled', async () => {
        const request = create();
        const controller = new AbortController();
        const pending = requestHlsRedirect('https://source.example/live.m3u8', {
            signal: controller.signal,
        });
        controller.abort();
        await expect(pending).rejects.toThrow('cancelled');
        expect(request.abort).toHaveBeenCalledTimes(1);
    });

    it('rejects redirect loops and unsupported protocols', async () => {
        const request = create();
        const pending = requestHlsRedirect(
            'https://source.example/live.m3u8',
            {}
        );
        for (let i = 0; i < 17; i++)
            request.emit(
                'redirect',
                302,
                'GET',
                'https://edge.example/loop',
                {}
            );
        await expect(pending).rejects.toThrow('Too many');
        const other = create();
        const unsupported = requestHlsRedirect(
            'https://source.example/live.m3u8',
            {}
        );
        other.emit('redirect', 302, 'GET', 'file:///private', {});
        await expect(unsupported).rejects.toThrow('Unsupported');
    });

    it('returns unsuccessful HTTP status without consuming the response body', async () => {
        const request = create();
        const pending = requestHlsRedirect(
            'https://source.example/live.m3u8',
            {}
        );
        request.emit('response', { statusCode: 403 });
        await expect(pending).resolves.toMatchObject({ ok: false });
        expect(request.abort).toHaveBeenCalled();
    });
});
