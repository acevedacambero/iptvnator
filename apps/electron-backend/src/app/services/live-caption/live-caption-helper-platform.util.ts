import { app } from 'electron';
import { accessSync, constants as fsConstants, statSync } from 'fs';
import path from 'path';

function dedupeDefinedPaths(paths: Array<string | undefined>): string[] {
    return [
        ...new Set(paths.filter((value): value is string => Boolean(value))),
    ];
}

function getLocalNativeDir(): string {
    return path.resolve(
        process.cwd(),
        'apps/electron-backend/native/build/Release'
    );
}

function getDistNativeDirs(): string[] {
    return [
        path.resolve(__dirname, 'native'),
        path.resolve(__dirname, '../../native'),
    ];
}

function getPackagedNativeDirs(): string[] {
    const resourcesPath = (
        process as NodeJS.Process & { resourcesPath?: string }
    ).resourcesPath;
    return dedupeDefinedPaths([
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
}

/** Returns the trusted Windows process-loopback helper for this app layout. */
export function resolveLiveCaptionHelperPath(): string | null {
    if (process.platform !== 'win32') {
        return null;
    }
    const directories = app.isPackaged
        ? getPackagedNativeDirs()
        : [getLocalNativeDir(), ...getDistNativeDirs()];
    for (const directory of dedupeDefinedPaths(directories)) {
        const candidate = path.join(directory, 'iptvnator_caption_helper.exe');
        try {
            accessSync(candidate, fsConstants.X_OK);
            if (statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // Try the next trusted native directory.
        }
    }
    return null;
}
