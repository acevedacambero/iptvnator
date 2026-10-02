#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WHISPER_CPP_SOURCE } from './whisper-source-pin.mjs';

const workspaceRoot = process.cwd();
const sourceRoot = path.join(
    workspaceRoot,
    'vendor',
    'live-caption',
    'whisper.cpp'
);
const stampPath = path.join(sourceRoot, 'iptvnator-source-revision.json');
const sourceLicensePath = path.join(sourceRoot, 'LICENSE');
const helperSourceRoot = path.join(
    workspaceRoot,
    'apps',
    'electron-backend',
    'native',
    'caption-helper'
);
const buildRoot = path.join(
    workspaceRoot,
    'apps',
    'electron-backend',
    'native',
    'build',
    'live-caption-whisper'
);
const outputDir = path.join(
    workspaceRoot,
    'apps',
    'electron-backend',
    'native',
    'build',
    'Release'
);
const outputFile = path.join(outputDir, 'iptvnator_whisper_helper.exe');
const outputLicenseFile = path.join(outputDir, 'LICENSE.whisper.cpp.txt');

function isTruthy(value) {
    return ['1', 'true', 'yes', 'on'].includes(
        String(value ?? '')
            .trim()
            .toLowerCase()
    );
}

// Existing official Windows builds already require the Embedded MPV runtime.
// Unless explicitly overridden, use that same gate for the caption helper so
// release/PR artifacts cannot silently ship the button without its ASR worker.
const explicitRequirement = process.env.IPTVNATOR_REQUIRE_LIVE_CAPTIONS;
const required =
    explicitRequirement === undefined
        ? isTruthy(process.env.IPTVNATOR_REQUIRE_EMBEDDED_MPV) &&
          process.platform === 'win32' &&
          process.arch === 'x64'
        : isTruthy(explicitRequirement);

function log(message) {
    process.stdout.write(`[live-caption] ${message}\n`);
}

function run(command, args) {
    log(`${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, {
        cwd: workspaceRoot,
        env: process.env,
        stdio: 'inherit',
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed with status ${result.status ?? 1}.`
        );
    }
}

function validatePinnedSource() {
    if (!fs.existsSync(stampPath)) {
        return false;
    }
    let stamp;
    try {
        stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    } catch {
        return false;
    }
    return (
        stamp?.repository === WHISPER_CPP_SOURCE.repository &&
        stamp?.tag === WHISPER_CPP_SOURCE.tag &&
        stamp?.commit === WHISPER_CPP_SOURCE.commit &&
        fs.existsSync(path.join(sourceRoot, 'CMakeLists.txt')) &&
        fs.existsSync(path.join(sourceRoot, 'include', 'whisper.h')) &&
        fs.existsSync(path.join(sourceRoot, 'ggml', 'CMakeLists.txt')) &&
        fs.existsSync(sourceLicensePath)
    );
}

function stagePinnedSourceIfRequired() {
    if (validatePinnedSource() || !required) {
        return;
    }
    run(process.execPath, ['tools/live-caption/stage-whisper-source.mjs']);
    if (!validatePinnedSource()) {
        throw new Error(
            `Pinned whisper.cpp ${WHISPER_CPP_SOURCE.tag} source staging completed without a valid revision stamp or LICENSE.`
        );
    }
}

function main() {
    fs.rmSync(outputFile, { force: true });
    fs.rmSync(outputLicenseFile, { force: true });
    if (process.platform !== 'win32' || process.arch !== 'x64') {
        if (required) {
            throw new Error(
                `Windows x64 live captions are required, but the build host is ${process.platform}-${process.arch}.`
            );
        }
        log(`Skipping Whisper helper on ${process.platform}-${process.arch}.`);
        return;
    }

    stagePinnedSourceIfRequired();
    if (!validatePinnedSource()) {
        const message = [
            'Pinned whisper.cpp source is not staged.',
            'Run: node tools/live-caption/stage-whisper-source.mjs',
            `Expected ${WHISPER_CPP_SOURCE.tag} (${WHISPER_CPP_SOURCE.commit}).`,
        ].join(' ');
        log(`Skipping optional Whisper helper. ${message}`);
        return;
    }

    fs.rmSync(buildRoot, { recursive: true, force: true });
    fs.mkdirSync(buildRoot, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    run('cmake', [
        '-S',
        helperSourceRoot,
        '-B',
        buildRoot,
        '-G',
        'Visual Studio 17 2022',
        '-A',
        'x64',
        `-DWHISPER_CPP_ROOT=${sourceRoot.replaceAll('\\', '/')}`,
    ]);
    run('cmake', [
        '--build',
        buildRoot,
        '--config',
        'Release',
        '--target',
        'iptvnator_whisper_helper',
        '--parallel',
    ]);

    const builtHelper = path.join(
        buildRoot,
        'bin',
        'iptvnator_whisper_helper.exe'
    );
    if (!fs.existsSync(builtHelper)) {
        throw new Error(
            `Whisper helper build produced no executable: ${builtHelper}`
        );
    }
    fs.copyFileSync(builtHelper, outputFile);
    fs.copyFileSync(sourceLicensePath, outputLicenseFile);
    if (!fs.statSync(outputFile).isFile() || fs.statSync(outputFile).size === 0) {
        throw new Error(`Whisper helper output is invalid: ${outputFile}`);
    }
    if (
        !fs.statSync(outputLicenseFile).isFile() ||
        fs.statSync(outputLicenseFile).size === 0
    ) {
        throw new Error(
            `Whisper helper license output is invalid: ${outputLicenseFile}`
        );
    }
    log(`Built ${path.relative(workspaceRoot, outputFile)}.`);
    log(`Packaged ${path.relative(workspaceRoot, outputLicenseFile)}.`);
}

try {
    main();
} catch (error) {
    process.stderr.write(
        `[live-caption] ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
}
