import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_LIVE_CAPTION_MODEL = Object.freeze({
    name: 'base.en-q5_1',
    fileName: 'ggml-base.en-q5_1.bin',
    // Pin the immutable HF revision that introduced this exact LFS object.
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/f281eb45af861ab5e5297d23694b7d46e090c02c/ggml-base.en-q5_1.bin',
    size: 59_721_011,
    sha256: '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f',
});

function defaultModelPath(): string {
    return path.join(
        app.getPath('userData'),
        'models',
        'whisper',
        DEFAULT_LIVE_CAPTION_MODEL.fileName
    );
}

async function sha256File(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

async function isVerifiedModel(filePath: string): Promise<boolean> {
    try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile() || stat.size !== DEFAULT_LIVE_CAPTION_MODEL.size) {
            return false;
        }
        return (await sha256File(filePath)) === DEFAULT_LIVE_CAPTION_MODEL.sha256;
    } catch {
        return false;
    }
}

/**
 * Download the pinned, quantized English baseline only after the user asks to
 * start live captions. A partial or mismatched object is never promoted to the
 * model path, and the .partial file is cleaned on every failure.
 */
export async function ensureDefaultLiveCaptionModel(): Promise<string> {
    const targetPath = defaultModelPath();
    if (await isVerifiedModel(targetPath)) {
        return targetPath;
    }

    const directory = path.dirname(targetPath);
    const partialPath = `${targetPath}.partial`;
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.rm(partialPath, { force: true });

    try {
        const response = await fetch(DEFAULT_LIVE_CAPTION_MODEL.url, {
            redirect: 'follow',
        });
        if (!response.ok || !response.body) {
            throw new Error(
                `Whisper model download failed: HTTP ${response.status} ${response.statusText}`
            );
        }
        const declaredLength = Number(response.headers.get('content-length'));
        if (
            Number.isFinite(declaredLength) &&
            declaredLength > 0 &&
            declaredLength !== DEFAULT_LIVE_CAPTION_MODEL.size
        ) {
            throw new Error(
                `Whisper model download size changed: expected ${DEFAULT_LIVE_CAPTION_MODEL.size}, received ${declaredLength}.`
            );
        }

        let received = 0;
        const hash = crypto.createHash('sha256');
        const source = Readable.fromWeb(
            response.body as import('node:stream/web').ReadableStream<Uint8Array>
        );
        source.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > DEFAULT_LIVE_CAPTION_MODEL.size) {
                source.destroy(new Error('Whisper model download exceeded expected size.'));
                return;
            }
            hash.update(chunk);
        });
        await pipeline(source, fs.createWriteStream(partialPath, { flags: 'wx' }));

        if (received !== DEFAULT_LIVE_CAPTION_MODEL.size) {
            throw new Error(
                `Whisper model download is incomplete: expected ${DEFAULT_LIVE_CAPTION_MODEL.size} bytes, received ${received}.`
            );
        }
        const digest = hash.digest('hex');
        if (digest !== DEFAULT_LIVE_CAPTION_MODEL.sha256) {
            throw new Error(
                `Whisper model SHA-256 mismatch: expected ${DEFAULT_LIVE_CAPTION_MODEL.sha256}, received ${digest}.`
            );
        }

        await fs.promises.rm(targetPath, { force: true });
        await fs.promises.rename(partialPath, targetPath);
        return targetPath;
    } catch (error) {
        await fs.promises.rm(partialPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export function getDefaultLiveCaptionModelPath(): string {
    return defaultModelPath();
}
