import { app } from 'electron';
import { accessSync, constants as fsConstants, statSync } from 'fs';
import path from 'path';

function dedupe(paths: Array<string | undefined>): string[] {
    return [...new Set(paths.filter((value): value is string => Boolean(value)))];
}

function readableRegularFile(filePath: string): boolean {
    try {
        accessSync(filePath, fsConstants.R_OK);
        return statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function nativeDirectories(): string[] {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
        .resourcesPath;
    const packaged = dedupe([
        resourcesPath
            ? path.resolve(
                  resourcesPath,
                  'app.asar.unpacked',
                  'electron-backend',
                  'native'
              )
            : undefined,
        app.getAppPath()
            ? path.join(
                  path.dirname(app.getAppPath()),
                  'app.asar.unpacked',
                  'electron-backend',
                  'native'
              )
            : undefined,
    ]);
    if (app.isPackaged) {
        return packaged;
    }
    return dedupe([
        path.resolve(process.cwd(), 'apps/electron-backend/native/build/Release'),
        path.resolve(__dirname, 'native'),
        path.resolve(__dirname, '../../native'),
        ...packaged,
    ]);
}

export function resolveLiveCaptionWhisperHelperPath(): string | null {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
        return null;
    }
    for (const directory of nativeDirectories()) {
        const candidate = path.join(directory, 'iptvnator_whisper_helper.exe');
        if (readableRegularFile(candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Development can set IPTVNATOR_WHISPER_MODEL or pass an explicit path.
 * Packaged builds use the verified on-demand quantized model by default while
 * retaining older full-model names for existing developer installations.
 */
export function resolveLiveCaptionWhisperModelPath(
    explicitPath?: string | null
): string | null {
    const modelDirectory = path.join(
        app.getPath('userData'),
        'models',
        'whisper'
    );
    const candidates = dedupe([
        explicitPath?.trim() || undefined,
        process.env.IPTVNATOR_WHISPER_MODEL?.trim() || undefined,
        path.join(modelDirectory, 'ggml-base.en-q5_1.bin'),
        path.join(modelDirectory, 'ggml-small.en.bin'),
        path.join(modelDirectory, 'ggml-base.en.bin'),
    ]);
    return candidates.find(readableRegularFile) ?? null;
}
