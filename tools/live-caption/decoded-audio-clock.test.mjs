import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

const helper = path.resolve(
    process.env.CAPTION_CLOCK_HELPER ??
        'apps/electron-backend/native/build/Release/iptvnator_caption_helper.exe'
);
const available = process.platform === 'win32' && fs.existsSync(helper);

function fixture(directory) {
    const pcm = Buffer.alloc(12 * 32000);
    for (let sample = 0; sample < pcm.length / 2; sample++) {
        const frequency = 300 + 100 * Math.floor(sample / 16000);
        pcm.writeInt16LE(
            Math.round(
                8000 * Math.sin((2 * Math.PI * frequency * sample) / 16000)
            ),
            sample * 2
        );
    }
    const header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(pcm.length + 36, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(
        path.join(directory, 'clock.wav'),
        Buffer.concat([header, pcm])
    );
    return pcm;
}

async function decode(source, start, CaptionAudioFrameReader) {
    const pipe = `\\\\.\\pipe\\caption-clock-test-${process.pid}-${Date.now()}`;
    const reader = new CaptionAudioFrameReader();
    const frames = [];
    let socket;
    let child;
    let failure;
    let origin;
    let ended = false;
    let pending = '';
    const guarded = (action) => {
        try {
            action();
        } catch (error) {
            failure ??= error;
            child?.kill();
        }
    };
    const server = net.createServer((connection) => {
        socket = connection;
        connection.on('data', (chunk) =>
            guarded(() => frames.push(...reader.pushPcm(chunk)))
        );
        connection.on('error', (error) => {
            failure ??= error;
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipe, resolve);
    });
    try {
        child = spawn(helper, ['--decode', pipe, String(start), 'auto'], {
            windowsHide: true,
        });
        child.stdin.write(`${source}\n\n\n\n`);
        child.stderr.on('data', (chunk) =>
            guarded(() => {
                pending += chunk;
                const lines = pending.split('\n');
                pending = lines.pop();
                for (const line of lines) {
                    const event = JSON.parse(line);
                    if (event.event === 'frame')
                        frames.push(...reader.pushStamp(event));
                    if (event.event === 'origin') origin = event.pts;
                    if (event.event === 'end') {
                        assert.equal(
                            event.error,
                            0,
                            'decoder must finish without lost clock events'
                        );
                        ended = true;
                    }
                }
            })
        );
        const timeout = setTimeout(() => {
            failure ??= new Error('Decoder timed out');
            child.kill();
        }, 15000);
        try {
            await new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', (code) => {
                    if (code !== 0)
                        failure ??= new Error(`Decoder exit ${code}`);
                    resolve();
                });
            });
            if (socket && !socket.readableEnded)
                await new Promise((resolve) => {
                    socket.once('end', resolve);
                    socket.once('close', resolve);
                });
        } finally {
            clearTimeout(timeout);
        }
        if (failure) throw failure;
        assert.ok(ended);
        reader.finish();
        assert.ok(frames.length > 20);
        return { frames, origin };
    } finally {
        child?.kill();
        socket?.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
}

test(
    'native decoded PCM follows its source clock after WAV and HLS seeks',
    {
        skip:
            !available &&
            'requires the built Windows caption helper and adjacent runtime',
        timeout: 45000,
    },
    async (t) => {
        const directory = fs.mkdtempSync(
            path.join(os.tmpdir(), 'iptvnator-caption-clock-')
        );
        try {
            const pcm = fixture(directory);
            await build({
                entryPoints: [
                    'apps/electron-backend/src/app/services/live-caption/live-caption-decoded-audio-source.ts',
                ],
                outfile: path.join(directory, 'reader.cjs'),
                bundle: true,
                platform: 'node',
                external: ['electron'],
            });
            // Resolve Electron from the workspace rather than this temporary bundle.
            const require = createRequire(path.resolve('package.json'));
            const source = fs.readFileSync(
                path.join(directory, 'reader.cjs'),
                'utf8'
            );
            const module = { exports: {} };
            new Function('require', 'module', 'exports', source)(
                require,
                module,
                module.exports
            );
            const { CaptionAudioFrameReader } = module.exports;
            await t.test(
                'every WAV frame matches input samples at its PTS',
                async () => {
                    for (const start of [0, 7.35]) {
                        const { frames } = await decode(
                            path.join(directory, 'clock.wav'),
                            start,
                            CaptionAudioFrameReader
                        );
                        for (const frame of frames) {
                            const offset = Math.round(frame.pts * 16000) * 2;
                            assert.deepEqual(
                                frame.pcm,
                                pcm.subarray(offset, offset + frame.pcm.length)
                            );
                        }
                    }
                }
            );
            const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
            const found =
                spawnSync(ffmpeg, ['-version'], {
                    windowsHide: true,
                    stdio: 'ignore',
                }).status === 0;
            await t.test(
                'HLS coarse seek retains correct tone timestamps instead of a three-second offset',
                {
                    skip:
                        !found &&
                        'requires FFmpeg to synthesize a local HLS fixture',
                },
                async () => {
                    const encoded = spawnSync(
                        ffmpeg,
                        [
                            '-hide_banner',
                            '-loglevel',
                            'error',
                            '-y',
                            '-f',
                            'lavfi',
                            '-i',
                            'color=s=160x90:r=25:d=12',
                            '-i',
                            path.join(directory, 'clock.wav'),
                            '-c:v',
                            'libx264',
                            '-g',
                            '150',
                            '-c:a',
                            'aac',
                            '-ar',
                            '48000',
                            '-f',
                            'hls',
                            '-hls_time',
                            '6',
                            '-hls_playlist_type',
                            'vod',
                            '-hls_segment_filename',
                            path.join(directory, 'segment-%d.ts'),
                            path.join(directory, 'clock.m3u8'),
                        ],
                        { windowsHide: true, encoding: 'utf8' }
                    );
                    assert.equal(encoded.status, 0, encoded.stderr);
                    const { frames, origin } = await decode(
                        path.join(directory, 'clock.m3u8'),
                        5.35,
                        CaptionAudioFrameReader
                    );
                    assert.ok(Number.isFinite(origin));
                    let checked = 0;
                    for (const frame of frames) {
                        const time = frame.pts - origin;
                        // Exclude codec priming and frames straddling a tone change.
                        if (
                            time < 0.2 ||
                            time > 11.8 ||
                            time % 1 > 0.8 ||
                            time % 1 < 0.2
                        )
                            continue;
                        let crossings = 0;
                        for (
                            let index = 2;
                            index < frame.pcm.length;
                            index += 2
                        )
                            if (
                                frame.pcm.readInt16LE(index) >= 0 &&
                                frame.pcm.readInt16LE(index - 2) < 0
                            )
                                crossings++;
                        const actual = crossings / (frame.end - frame.pts);
                        const expected = 300 + 100 * Math.floor(time);
                        assert.ok(
                            Math.abs(actual - expected) <= 30,
                            `PTS ${frame.pts}: ${actual} Hz, expected ${expected}`
                        );
                        checked++;
                    }
                    assert.ok(checked > 20);
                }
            );
        } finally {
            // Only generated files directly inside this uniquely owned directory.
            for (const name of fs.readdirSync(directory))
                fs.unlinkSync(path.join(directory, name));
            fs.rmdirSync(directory);
        }
    }
);
