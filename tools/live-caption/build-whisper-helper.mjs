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

function run(command, args, env = process.env) {
    log(`${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, {
        cwd: workspaceRoot,
        env,
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

function runCapture(command, args, env = process.env) {
    const result = spawnSync(command, args, {
        cwd: workspaceRoot,
        env,
        encoding: 'utf8',
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed with status ${result.status ?? 1}.`
        );
    }
    return String(result.stdout ?? '').trim();
}

function findVsWhere() {
    const explicit = process.env.VSWHERE_PATH;
    if (explicit && fs.existsSync(explicit)) {
        return explicit;
    }
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    if (!programFilesX86) {
        return undefined;
    }
    const candidate = path.join(
        programFilesX86,
        'Microsoft Visual Studio',
        'Installer',
        'vswhere.exe'
    );
    return fs.existsSync(candidate) ? candidate : undefined;
}

function getVisualStudioInfo() {
    const vswhere = findVsWhere();
    if (!vswhere) {
        throw new Error(
            'Visual Studio Installer vswhere.exe was not found. Install Visual Studio Build Tools with the Desktop development with C++ workload.'
        );
    }

    const version = runCapture(vswhere, [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Workload.VCTools',
        '-property',
        'installationVersion',
    ]);
    const installationPath = runCapture(vswhere, [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Workload.VCTools',
        '-property',
        'installationPath',
    ]);
    const major = Number.parseInt(version.split('.')[0] ?? '', 10);
    if (!Number.isFinite(major) || !installationPath) {
        throw new Error(
            `Unable to determine the installed Visual Studio C++ toolchain from vswhere output (version=${version || '(empty)'}, path=${installationPath || '(empty)'}).`
        );
    }
    if (major < 17) {
        throw new Error(
            `Visual Studio ${version} is too old. Visual Studio 2022 or newer is required.`
        );
    }
    return { version, installationPath, major };
}

function loadVisualStudioDeveloperEnvironment(installationPath) {
    const vsDevCmd = path.join(
        installationPath,
        'Common7',
        'Tools',
        'VsDevCmd.bat'
    );
    if (!fs.existsSync(vsDevCmd)) {
        throw new Error(
            `Visual Studio developer environment script was not found: ${vsDevCmd}`
        );
    }

    const comSpec = process.env.ComSpec || 'cmd.exe';
    const commandLine = `call "${vsDevCmd}" -arch=x64 -host_arch=x64 >nul && set`;
    const result = spawnSync(comSpec, ['/d', '/s', '/c', commandLine], {
        cwd: workspaceRoot,
        env: process.env,
        encoding: 'utf8',
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(
            `Failed to initialize the Visual Studio x64 developer environment with status ${result.status ?? 1}.`
        );
    }

    const env = {};
    for (const rawLine of String(result.stdout ?? '').split(/\r?\n/)) {
        const separator = rawLine.indexOf('=');
        if (separator <= 0) {
            continue;
        }
        env[rawLine.slice(0, separator)] = rawLine.slice(separator + 1);
    }
    if (!env.VSCMD_VER) {
        throw new Error(
            'Visual Studio developer environment initialized without VSCMD_VER.'
        );
    }
    return env;
}

function resolveBuildStrategy() {
    const visualStudio = getVisualStudioInfo();
    const cmakeHelp = runCapture('cmake', ['--help']);
    const preferredGenerator =
        visualStudio.major >= 18
            ? 'Visual Studio 18 2026'
            : 'Visual Studio 17 2022';

    if (cmakeHelp.includes(preferredGenerator)) {
        log(
            `Using ${preferredGenerator} for Visual Studio ${visualStudio.version}.`
        );
        return {
            generator: preferredGenerator,
            env: process.env,
            multiConfig: true,
        };
    }

    if (!cmakeHelp.includes('NMake Makefiles')) {
        const versionText = runCapture('cmake', ['--version'])
            .split(/\r?\n/)[0]
            .trim();
        throw new Error(
            `${preferredGenerator} is not available in ${versionText || 'the current CMake'}, and the NMake Makefiles fallback is also unavailable.`
        );
    }

    const devEnv = loadVisualStudioDeveloperEnvironment(
        visualStudio.installationPath
    );
    const whereNMake = runCapture('where.exe', ['nmake.exe'], devEnv);
    const whereCl = runCapture('where.exe', ['cl.exe'], devEnv);
    log(
        `CMake does not provide ${preferredGenerator}; using NMake Makefiles with Visual Studio ${visualStudio.version}.`
    );
    log(`MSVC compiler: ${whereCl.split(/\r?\n/)[0]}`);
    log(`NMake: ${whereNMake.split(/\r?\n/)[0]}`);
    return {
        generator: 'NMake Makefiles',
        env: devEnv,
        multiConfig: false,
    };
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

    const strategy = resolveBuildStrategy();
    const configureArgs = [
        '-S',
        helperSourceRoot,
        '-B',
        buildRoot,
        '-G',
        strategy.generator,
    ];
    if (strategy.multiConfig) {
        configureArgs.push('-A', 'x64');
    } else {
        configureArgs.push('-DCMAKE_BUILD_TYPE=Release');
    }
    configureArgs.push(
        `-DWHISPER_CPP_ROOT=${sourceRoot.replaceAll('\\', '/')}`
    );
    run('cmake', configureArgs, strategy.env);

    const buildArgs = [
        '--build',
        buildRoot,
        '--target',
        'iptvnator_whisper_helper',
        '--parallel',
    ];
    if (strategy.multiConfig) {
        buildArgs.splice(2, 0, '--config', 'Release');
    }
    run('cmake', buildArgs, strategy.env);

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
