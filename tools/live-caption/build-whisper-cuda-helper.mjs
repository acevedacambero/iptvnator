#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WHISPER_CPP_SOURCE } from './whisper-source-pin.mjs';

// Separate opt-in build: the regular native/Release CPU worker is preserved.
const root = process.cwd();
const sdk = path.resolve(process.env.IPTVNATOR_CUDA_ROOT || '');
const source = path.join(root, 'vendor/live-caption/whisper.cpp');
const build = path.join(
    root,
    'apps/electron-backend/native/build/live-caption-cuda'
);
const output = path.join(build, 'bin');
const cmake = process.env.CMAKE_EXE || 'cmake';

function run(command, args, env = process.env) {
    const result = spawnSync(command, args, {
        cwd: root,
        env,
        stdio: 'inherit',
        windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`${path.basename(command)} failed (${result.status}).`);
}

function developerEnvironment() {
    const vswhere = path.join(
        process.env['ProgramFiles(x86)'],
        'Microsoft Visual Studio/Installer/vswhere.exe'
    );
    const found = spawnSync(
        vswhere,
        [
            '-latest',
            '-products',
            '*',
            '-requires',
            'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
            '-property',
            'installationPath',
        ],
        { encoding: 'utf8', windowsHide: true }
    );
    if (found.status !== 0 || !found.stdout.trim())
        throw new Error('MSVC Build Tools not found.');
    const script = path.join(found.stdout.trim(), 'Common7/Tools/VsDevCmd.bat');
    const initialized = spawnSync(
        process.env.ComSpec,
        ['/d', '/s', '/c', `call "${script}" -arch=x64 -host_arch=x64 && set`],
        { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }
    );
    if (initialized.status !== 0)
        throw new Error('MSVC environment initialization failed.');
    const env = { ...process.env };
    for (const line of initialized.stdout.split(/\r?\n/)) {
        const separator = line.indexOf('=');
        if (separator > 0)
            env[line.slice(0, separator)] = line.slice(separator + 1);
    }
    // Do not print the captured environment: it may contain credentials.
    return env;
}

try {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
        throw new Error('The CUDA caption worker build requires Windows x64.');
    }
    if (!process.env.IPTVNATOR_CUDA_ROOT)
        throw new Error('Set IPTVNATOR_CUDA_ROOT to a CUDA 13 SDK.');
    const stamp = JSON.parse(
        fs.readFileSync(
            path.join(source, 'iptvnator-source-revision.json'),
            'utf8'
        )
    );
    if (
        stamp.repository !== WHISPER_CPP_SOURCE.repository ||
        stamp.commit !== WHISPER_CPP_SOURCE.commit
    ) {
        throw new Error(
            'The staged Whisper source does not match the pinned revision.'
        );
    }
    const compiler = path.join(sdk, 'bin/nvcc.exe');
    const version = spawnSync(compiler, ['--version'], {
        encoding: 'utf8',
        windowsHide: true,
    });
    if (version.status !== 0 || !/release 13\./.test(version.stdout)) {
        throw new Error('A CUDA 13 SDK is required for this optional build.');
    }
    const runtime = fs.existsSync(path.join(sdk, 'bin/x64/cublas64_13.dll'))
        ? path.join(sdk, 'bin/x64')
        : path.join(sdk, 'bin');
    const dlls = ['cublas64_13.dll', 'cublasLt64_13.dll', 'cudart64_13.dll'];
    for (const dll of dlls) {
        if (!fs.statSync(path.join(runtime, dll)).isFile())
            throw new Error(`Missing CUDA runtime: ${dll}`);
    }
    const license = process.env.IPTVNATOR_CUDA_LICENSE;
    if (!license || !fs.statSync(license).isFile()) {
        throw new Error(
            'Set IPTVNATOR_CUDA_LICENSE to the NVIDIA SDK license file.'
        );
    }
    const env = developerEnvironment();
    run(
        cmake,
        [
            '-S',
            path.join(root, 'apps/electron-backend/native/caption-helper'),
            '-B',
            build,
            '-G',
            'Ninja',
            '-DCMAKE_BUILD_TYPE=Release',
            '-DCMAKE_C_COMPILER=cl',
            '-DCMAKE_CXX_COMPILER=cl',
            `-DWHISPER_CPP_ROOT=${source.replaceAll('\\', '/')}`,
            '-DIPTVNATOR_WHISPER_CUDA=ON',
            `-DCUDAToolkit_ROOT=${sdk.replaceAll('\\', '/')}`,
            `-DCMAKE_CUDA_COMPILER=${compiler.replaceAll('\\', '/')}`,
            `-DCMAKE_CUDA_ARCHITECTURES=${process.env.IPTVNATOR_WHISPER_CUDA_ARCHITECTURES || 'native'}`,
        ],
        env
    );
    run(
        cmake,
        [
            '--build',
            build,
            '--target',
            'iptvnator_whisper_helper',
            '--parallel',
            '6',
        ],
        env
    );
    for (const dll of dlls)
        fs.copyFileSync(path.join(runtime, dll), path.join(output, dll));
    fs.copyFileSync(license, path.join(output, 'LICENSE.nvidia-cuda.txt'));
    fs.copyFileSync(
        path.join(source, 'LICENSE'),
        path.join(output, 'LICENSE.whisper.cpp.txt')
    );
    console.log(
        `[live-caption] Optional CUDA worker and runtime staged at ${output}`
    );
} catch (error) {
    console.error(`[live-caption] ${error.message}`);
    process.exitCode = 1;
}
