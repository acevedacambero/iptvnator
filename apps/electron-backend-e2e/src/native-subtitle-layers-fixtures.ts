import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { xtreamMockServer } from './electron-test-fixtures';

export function createNativeLayerVideo(directory: string): string | null {
    const available = spawnSync('ffmpeg', ['-version'], {
        windowsHide: true,
        stdio: 'ignore',
    });
    if (available.status !== 0) return null;
    const english = join(directory, 'layer-english.srt');
    const chinese = join(directory, 'layer-chinese.srt');
    const times = [
        '00:00:00,000 --> 00:00:03,000',
        '00:00:03,000 --> 00:00:06,000',
        '00:00:06,000 --> 00:00:09,000',
    ];
    const source = [
        'English first line',
        'English second line',
        'English final line',
    ];
    const target = ['第一条中文字幕', '第二条中文字幕', '最后一条中文字幕'];
    writeFileSync(
        english,
        times.map((time, i) => `${i + 1}\n${time}\n${source[i]}\n`).join('\n')
    );
    writeFileSync(
        chinese,
        times.map((time, i) => `${i + 1}\n${time}\n${target[i]}\n`).join('\n')
    );
    const video = join(directory, 'layered-source.mkv');
    const result = spawnSync(
        'ffmpeg',
        [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'lavfi',
            '-i',
            'color=c=0x243449:s=640x360:r=25:d=12',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=48000:duration=12',
            '-i',
            english,
            '-i',
            chinese,
            '-map',
            '0:v',
            '-map',
            '1:a',
            '-map',
            '2:s',
            '-map',
            '3:s',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-c:s',
            'ass',
            '-metadata:s:s:0',
            'language=eng',
            '-metadata:s:s:0',
            'title=English',
            '-metadata:s:s:1',
            'language=chi',
            '-metadata:s:s:1',
            'title=Chinese',
            video,
        ],
        { windowsHide: true, encoding: 'utf8', timeout: 30000 }
    );
    if (result.status !== 0)
        throw new Error(`Subtitle fixture generation failed: ${result.stderr}`);
    return video;
}

/** Real Xtream UI with local media; credentials are synthetic fixture values. */
export async function createNativeLayerPortal(
    video: string
): Promise<{ url: string; close: () => Promise<void> }> {
    const bytes = readFileSync(video);
    const server = createServer(async (request, response) => {
        try {
            if (/^\/(movie|series)\//.test(request.url ?? '')) {
                const range = /bytes=(\d+)-(\d*)/.exec(
                    request.headers.range ?? ''
                );
                const start = range ? Number(range[1]) : 0;
                const end = range?.[2]
                    ? Math.min(Number(range[2]), bytes.length - 1)
                    : bytes.length - 1;
                if (start > end) {
                    response.writeHead(416);
                    response.end();
                    return;
                }
                response.writeHead(range ? 206 : 200, {
                    'Content-Type': 'video/x-matroska',
                    'Content-Length': end - start + 1,
                    'Accept-Ranges': 'bytes',
                    ...(range
                        ? {
                              'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
                          }
                        : {}),
                });
                response.end(bytes.subarray(start, end + 1));
                return;
            }
            const upstream = await fetch(
                `${xtreamMockServer}${request.url ?? '/'}`
            );
            response.writeHead(upstream.status, {
                'Content-Type':
                    upstream.headers.get('content-type') ?? 'application/json',
            });
            response.end(Buffer.from(await upstream.arrayBuffer()));
        } catch {
            response.writeHead(500);
            response.end();
        }
    });
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('Local fixture port missing.');
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}
