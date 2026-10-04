import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const root = process.cwd();
const cpu = path.resolve(
    process.env.CAPTION_CPU_WORKER ||
        'apps/electron-backend/native/build/live-caption-whisper/bin/iptvnator_whisper_helper.exe'
);
const cuda = path.resolve(
    process.env.CAPTION_CUDA_WORKER ||
        'apps/electron-backend/native/build/live-caption-cuda/bin/iptvnator_whisper_helper.exe'
);
const small = process.env.CAPTION_SMALL_MODEL;
const large = process.env.CAPTION_LARGE_MODEL;
const windows = process.platform === 'win32' && process.arch === 'x64';

function worker(executable, model, device) {
    const env = { ...process.env };
    delete env.IPTVNATOR_WHISPER_DEVICE;
    if (device) env.IPTVNATOR_WHISPER_DEVICE = device;
    const child = spawn(executable, ['--model', model, '--threads', '8'], {
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const queued = [];
    let buffer = '',
        stderr = '',
        listener,
        failure;
    function deliver(value) {
        if (listener) {
            const resolve = listener;
            listener = undefined;
            resolve(value);
        } else queued.push(value);
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
            const end = buffer.indexOf('\n');
            if (end < 0) break;
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
                deliver(JSON.parse(line));
            } catch (error) {
                failure = error;
                listener?.(error);
            }
        }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-16384);
    });
    const closed = new Promise((resolve, reject) => {
        child.once('error', (error) => {
            failure = error;
            listener?.(error);
            reject(error);
        });
        child.once('close', (code) => {
            failure = new Error(`Worker closed (${code}): ${stderr}`);
            listener?.(failure);
            resolve({ code, stderr });
        });
    });
    closed.catch(() => undefined);
    async function next() {
        const value = queued.length
            ? queued.shift()
            : failure ||
              (await new Promise((resolve) => {
                  const timer = setTimeout(() => {
                      child.kill();
                      resolve(new Error('Worker reply timed out.'));
                  }, 30000);
                  listener = (reply) => {
                      clearTimeout(timer);
                      resolve(reply);
                  };
              }));
        if (value instanceof Error) throw value;
        return value;
    }
    return {
        child,
        closed,
        next,
        request(id, pcm) {
            const header = Buffer.alloc(8);
            header.writeUInt32LE(id);
            header.writeUInt32LE(pcm.length, 4);
            child.stdin.write(Buffer.concat([header, pcm]));
            return next();
        },
        async stop() {
            child.stdin.end();
            await closed;
        },
    };
}

function sample() {
    const wav = fs.readFileSync(
        path.join(root, 'vendor/live-caption/whisper.cpp/samples/jfk.wav')
    );
    let offset = 12;
    while (offset + 8 <= wav.length) {
        const size = wav.readUInt32LE(offset + 4);
        if (wav.toString('ascii', offset, offset + 4) === 'data') {
            return wav.subarray(
                offset + 8,
                offset + 8 + Math.min(size, 8 * 32000)
            );
        }
        offset += 8 + size + (size & 1);
    }
    throw new Error('The pinned JFK WAV sample has no PCM data.');
}

test(
    'CPU compatibility worker rejects a required CUDA device',
    {
        skip: !windows || !fs.existsSync(cpu),
        timeout: 15000,
    },
    async () => {
        const probe = worker(cpu, 'unused.bin', 'cuda');
        const result = await probe.closed;
        assert.equal(result.code, 3);
        assert.match(
            result.stderr,
            /requested CUDA caption device is unavailable/
        );
    }
);

test(
    'invalid device configuration fails explicitly',
    {
        skip: !windows || !fs.existsSync(cpu),
        timeout: 15000,
    },
    async () => {
        const probe = worker(cpu, 'unused.bin', 'invalid');
        assert.equal((await probe.closed).code, 64);
    }
);

for (const [name, executable, device] of [
    ['CPU baseline', cpu, undefined],
    ['CUDA build with CPU override', cuda, 'cpu'],
]) {
    test(
        `${name} retains framing and English token timestamps`,
        {
            skip: !windows || !small || !fs.existsSync(executable),
            timeout: 60000,
        },
        async () => {
            const probe = worker(executable, small, device);
            try {
                assert.equal((await probe.next()).backend, 'CPU');
                assert.equal(
                    (await probe.request(41, Buffer.alloc(3))).error,
                    'invalid-pcm-size'
                );
                const result = await probe.request(42, sample());
                assert.equal(result.id, 42);
                assert.equal(result.ok, true);
                assert.ok(result.text.length > 0);
                assert.ok(result.tokens.length > 0);
                assert.ok(
                    result.tokens.every(
                        (token) =>
                            Number.isFinite(token.startMs) &&
                            token.startMs >= 0 &&
                            token.endMs >= token.startMs
                    )
                );
            } finally {
                await probe.stop();
            }
        }
    );
}

test(
    'full Large v3 runs on CUDA with the existing caption protocol',
    {
        skip: !windows || !large || !fs.existsSync(cuda),
        timeout: 60000,
    },
    async () => {
        const probe = worker(cuda, large, 'cuda');
        try {
            assert.equal((await probe.next()).backend, 'CUDA');
            const result = await probe.request(7, sample());
            assert.equal(result.id, 7);
            assert.equal(result.ok, true);
            assert.ok(result.text.length > 0);
            assert.ok(result.tokens.length > 0);
            assert.ok(
                result.tokens.every(
                    (token) =>
                        Number.isFinite(token.startMs) &&
                        token.startMs >= 0 &&
                        token.endMs >= token.startMs
                )
            );
        } finally {
            await probe.stop();
        }
    }
);
