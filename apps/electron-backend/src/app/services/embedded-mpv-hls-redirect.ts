import { net } from 'electron';

/** net.fetch currently reports the input URL even after a redirect. */
export function requestHlsRedirect(
    url: string,
    init: RequestInit
): Promise<
    Pick<Response, 'ok' | 'url'> & { body?: ReadableStream<Uint8Array> }
> {
    return new Promise((resolve, reject) => {
        const request = net.request({
            url,
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            cache: 'no-store',
        });
        let finalUrl = url;
        let redirects = 0;
        let settled = false;
        const settle = (error?: Error, status?: number) => {
            if (settled) return;
            settled = true;
            init.signal?.removeEventListener('abort', abort);
            if (error) reject(error);
            else
                resolve({
                    ok: status !== undefined && status >= 200 && status < 300,
                    url: finalUrl,
                });
            request.abort();
        };
        const abort = () =>
            settle(new Error('HLS redirect resolution cancelled'));
        request.on('redirect', (_status, _method, target) => {
            if (++redirects > 16)
                return settle(new Error('Too many HLS redirects'));
            if (!/^https?:\/\//i.test(target))
                return settle(new Error('Unsupported redirect protocol'));
            finalUrl = target;
            request.followRedirect();
        });
        request.on('response', (response) =>
            settle(undefined, response.statusCode)
        );
        request.on('error', () =>
            settle(new Error('HLS redirect request failed'))
        );
        init.signal?.addEventListener('abort', abort, { once: true });
        if (init.signal?.aborted) return abort();
        try {
            new Headers(init.headers).forEach((value, name) =>
                request.setHeader(name, value)
            );
            request.end();
        } catch {
            settle(new Error('Unsupported HLS request headers'));
        }
    });
}
