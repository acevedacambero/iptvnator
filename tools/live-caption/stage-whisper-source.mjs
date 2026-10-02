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
const stampPath = path.join(destination, 'iptvnator-source-revision.json');

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

function readVerifiedStamp() {
    if (!fs.existsSync(stampPath)) {
        return null;
    }
    try {
        const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
        return stamp?.repository === WHISPER_CPP_SOURCE.repository &&
            stamp?.tag === WHISPER_CPP_SOURCE.tag &&
            stamp?.commit === WHISPER_CPP_SOURCE.commit &&
            fs.existsSync(path.join(destination, 'CMakeLists.txt')) &&
            fs.existsSync(path.join(destination, 'include', 'whisper.h')) &&
            fs.existsSync(path.join(destination, 'ggml', 'CMakeLists.txt'))
            ? stamp.commit
            : null;
    } catch {
        return null;
    }
}

function gitRevision() {
    if (!fs.existsSync(path.join(destination, '.git'))) {
        return null;
    }
    return run('git', ['rev-parse', 'HEAD'], {
        cwd: destination,
        capture: true,
    });
}

if (readVerifiedStamp() === WHISPER_CPP_SOURCE.commit) {
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

const revision = gitRevision();
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
    stampPath,
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
