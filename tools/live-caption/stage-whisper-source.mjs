#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WHISPER_CPP_SOURCE } from './whisper-source-pin.mjs';

const workspaceRoot = process.cwd();
const destination = path.join(
    workspaceRoot,
    'vendor',
    'live-caption',
    'whisper.cpp'
);

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? workspaceRoot,
        encoding: 'utf8',
        stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        ...options,
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed with status ${result.status ?? 1}${
                result.stderr ? `: ${result.stderr.trim()}` : ''
            }`
        );
    }
    return result.stdout?.trim() ?? '';
}

function currentRevision() {
    if (!fs.existsSync(path.join(destination, '.git'))) {
        return null;
    }
    return run('git', ['rev-parse', 'HEAD'], {
        cwd: destination,
        capture: true,
    });
}

const current = currentRevision();
if (current === WHISPER_CPP_SOURCE.commit) {
    process.stdout.write(
        `[live-caption] whisper.cpp ${WHISPER_CPP_SOURCE.tag} already staged at ${destination}\n`
    );
    process.exit(0);
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destination), { recursive: true });
run('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    WHISPER_CPP_SOURCE.tag,
    '--single-branch',
    WHISPER_CPP_SOURCE.repository,
    destination,
]);

const revision = currentRevision();
if (revision !== WHISPER_CPP_SOURCE.commit) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw new Error(
        `Pinned whisper.cpp tag ${WHISPER_CPP_SOURCE.tag} resolved to ${revision ?? '<missing>'}, expected ${WHISPER_CPP_SOURCE.commit}.`
    );
}

// Strip VCS metadata from the build input after verifying the immutable commit.
// The exact revision remains in the checked-in pin and in the generated stamp.
fs.rmSync(path.join(destination, '.git'), { recursive: true, force: true });
fs.writeFileSync(
    path.join(destination, 'iptvnator-source-revision.json'),
    `${JSON.stringify(
        {
            repository: WHISPER_CPP_SOURCE.repository,
            tag: WHISPER_CPP_SOURCE.tag,
            commit: WHISPER_CPP_SOURCE.commit,
        },
        null,
        2
    )}\n`
);
process.stdout.write(
    `[live-caption] staged whisper.cpp ${WHISPER_CPP_SOURCE.tag} (${WHISPER_CPP_SOURCE.commit})\n`
);
