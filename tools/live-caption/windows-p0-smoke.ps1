param(
    [switch]$SkipInstall,
    [switch]$SkipTests,
    [switch]$SkipRuntimeStage,
    [switch]$SkipPackage,
    [switch]$LaunchP0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    Write-Host ("> {0} {1}" -f $Command, ($Arguments -join ' '))
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command exited with code $LASTEXITCODE"
    }
}

function Assert-File([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Missing ${Label}: $Path"
    }
    $length = (Get-Item -LiteralPath $Path).Length
    if ($length -le 0) {
        throw "$Label is empty: $Path"
    }
    Write-Host "  OK  $Label"
}

function Assert-OneFile([string[]]$Candidates, [string]$Label) {
    foreach ($candidate in $Candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            Assert-File $candidate $Label
            return $candidate
        }
    }
    throw "Missing $Label. Checked: $($Candidates -join ', ')"
}

function Assert-UsageExit([string]$Path, [string]$Label) {
    & $Path *> $null
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 64) {
        throw "$Label did not start cleanly; expected usage exit code 64, received $exitCode ($Path)"
    }
    Write-Host "  OK  $Label executable starts (usage exit 64)"
}

function Get-WindowsBuildNumber {
    try {
        $currentVersion = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
        return [int]$currentVersion.CurrentBuildNumber
    } catch {
        return [Environment]::OSVersion.Version.Build
    }
}

function Get-NodeArch {
    $arch = (& node -p "process.arch").Trim()
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to read Node architecture.'
    }
    return $arch
}

function Assert-CMakeBuildPath {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
        throw 'Visual Studio Build Tools detection failed because vswhere.exe is missing.'
    }

    $installationVersion = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Workload.VCTools -property installationVersion).Trim()
    $installationPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Workload.VCTools -property installationPath).Trim()
    if (-not $installationVersion -or -not $installationPath) {
        throw 'Visual Studio Build Tools with the C++ workload was not found.'
    }

    $vsMajor = [int]($installationVersion.Split('.')[0])
    $cmakeHelp = (& cmake --help | Out-String)
    $expectedGenerator = switch ($vsMajor) {
        18 { 'Visual Studio 18 2026' }
        17 { 'Visual Studio 17 2022' }
        default { $null }
    }

    if (-not $expectedGenerator) {
        throw "Unsupported Visual Studio major version $vsMajor ($installationVersion)."
    }

    if ($cmakeHelp -match [Regex]::Escape($expectedGenerator)) {
        Write-Host "  OK  CMake generator: $expectedGenerator (Visual Studio $installationVersion)"
        return
    }

    $vsDevCmd = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
    if (
        $cmakeHelp -match [Regex]::Escape('NMake Makefiles') -and
        (Test-Path -LiteralPath $vsDevCmd -PathType Leaf)
    ) {
        Write-Host "  OK  CMake fallback: NMake Makefiles via Visual Studio $installationVersion"
        return
    }

    throw "CMake cannot build with Visual Studio $installationVersion: neither '$expectedGenerator' nor the NMake Makefiles fallback is available."
}

if ($env:OS -ne 'Windows_NT') {
    throw 'This smoke harness must run on Windows.'
}
if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'Windows x64 is required.'
}
if ($LaunchP0 -and $SkipPackage) {
    throw '-LaunchP0 requires packaging; remove -SkipPackage.'
}

foreach ($command in @('node', 'pnpm', 'git', 'cmake')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command is not on PATH: $command"
    }
}
Assert-CMakeBuildPath

$buildNumber = Get-WindowsBuildNumber
if ($buildNumber -lt 20348) {
    throw "Windows build 20348 or newer is required for process-scoped WASAPI loopback. Current build: $buildNumber"
}

$nodeArch = Get-NodeArch
if ($nodeArch -ne 'x64') {
    throw "Node x64 is required. Current Node architecture: $nodeArch"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
Push-Location $repoRoot

$builderPath = Join-Path $repoRoot 'electron-builder.json'
$builderOriginal = [IO.File]::ReadAllText($builderPath)
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

try {
    Write-Step "Windows P0 environment (build $buildNumber, Node $nodeArch)"

    if (-not $SkipInstall) {
        Write-Step 'Installing workspace dependencies'
        Invoke-Checked 'pnpm' @('install', '--frozen-lockfile')
    }

    if (-not $SkipRuntimeStage) {
        Write-Step 'Staging checksum-pinned Windows libmpv runtime'
        $pinPath = Join-Path $repoRoot 'tools\embedded-mpv\windows-runtime-pin.json'
        $pin = Get-Content -LiteralPath $pinPath -Raw | ConvertFrom-Json
        Invoke-Checked 'node' @(
            'tools/embedded-mpv/stage-windows-runtime-archive.mjs',
            [string]$pin.asset.url,
            [string]$pin.asset.sha256
        )
    }

    Write-Step 'Staging pinned whisper.cpp source'
    Invoke-Checked 'node' @('tools/live-caption/stage-whisper-source.mjs')

    $env:IPTVNATOR_EMBEDDED_MPV_PLATFORM = 'win32'
    $env:IPTVNATOR_EMBEDDED_MPV_ARCH = 'x64'
    $env:IPTVNATOR_REQUIRE_EMBEDDED_MPV = '1'
    $env:IPTVNATOR_REQUIRE_LIVE_CAPTIONS = '1'

    if (-not $SkipTests) {
        Write-Step 'Running TypeScript checks'
        Invoke-Checked 'pnpm' @('run', 'typecheck:ci')

        Write-Step 'Running live-caption unit tests'
        Invoke-Checked 'pnpm' @(
            'nx',
            'test',
            'electron-backend',
            '--runInBand',
            '--testPathPatterns=apps/electron-backend/src/app/services/live-caption'
        )
    }

    Write-Step 'Building production Electron backend and native caption helpers'
    Invoke-Checked 'pnpm' @('run', 'build:backend')

    $nativeDist = Join-Path $repoRoot 'dist\apps\electron-backend\native'
    $captureHelper = Join-Path $nativeDist 'iptvnator_caption_helper.exe'
    $whisperHelper = Join-Path $nativeDist 'iptvnator_whisper_helper.exe'
    Assert-File (Join-Path $nativeDist 'embedded_mpv.node') 'Embedded MPV addon'
    Assert-File $captureHelper 'WASAPI capture helper'
    Assert-File $whisperHelper 'Whisper ASR helper'
    Assert-File (Join-Path $nativeDist 'LICENSE.whisper.cpp.txt') 'whisper.cpp license'
    Assert-File (Join-Path $repoRoot 'dist\apps\electron-backend\live-caption.preload.js') 'live-caption preload'
    Assert-OneFile @(
        (Join-Path $nativeDist 'mpv-2.dll'),
        (Join-Path $nativeDist 'libmpv-2.dll'),
        (Join-Path $nativeDist 'mpv.dll'),
        (Join-Path $nativeDist 'libmpv.dll'),
        (Join-Path $nativeDist 'lib\mpv-2.dll'),
        (Join-Path $nativeDist 'lib\libmpv-2.dll'),
        (Join-Path $nativeDist 'lib\mpv.dll'),
        (Join-Path $nativeDist 'lib\libmpv.dll')
    ) 'libmpv runtime' | Out-Null

    Write-Step 'Probing native helper executables'
    Assert-UsageExit $captureHelper 'WASAPI capture helper'
    Assert-UsageExit $whisperHelper 'Whisper ASR helper'

    if (-not $SkipPackage) {
        Write-Step 'Temporarily constraining electron-builder Windows output to x64'
        $builder = $builderOriginal | ConvertFrom-Json
        foreach ($target in @($builder.win.target)) {
            if ($null -ne $target -and $target -isnot [string]) {
                $target.arch = @('x64')
            }
        }
        $builderJson = $builder | ConvertTo-Json -Depth 100
        [IO.File]::WriteAllText($builderPath, $builderJson + "`n", $utf8NoBom)
        $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'

        Write-Step 'Building unsigned local Windows package'
        Invoke-Checked 'pnpm' @('run', 'make:app', '--', '--publishPolicy=never')

        $unpackedExe = Get-ChildItem -Path (Join-Path $repoRoot 'dist\executables') -Recurse -Filter 'IPTVnator.exe' -File |
            Where-Object { $_.FullName -match 'win.*unpacked' } |
            Select-Object -First 1
        if (-not $unpackedExe) {
            throw 'Unable to locate the packaged Windows IPTVnator.exe under dist\executables.'
        }

        $packageNative = Join-Path $unpackedExe.Directory.FullName 'resources\app.asar.unpacked\electron-backend\native'
        $packagedCaptureHelper = Join-Path $packageNative 'iptvnator_caption_helper.exe'
        $packagedWhisperHelper = Join-Path $packageNative 'iptvnator_whisper_helper.exe'
        Assert-File $packagedCaptureHelper 'packaged WASAPI capture helper'
        Assert-File $packagedWhisperHelper 'packaged Whisper ASR helper'
        Assert-File (Join-Path $packageNative 'LICENSE.whisper.cpp.txt') 'packaged whisper.cpp license'
        Assert-UsageExit $packagedCaptureHelper 'packaged WASAPI capture helper'
        Assert-UsageExit $packagedWhisperHelper 'packaged Whisper ASR helper'

        Write-Host "`nPackaged executable: $($unpackedExe.FullName)" -ForegroundColor Green

        if ($LaunchP0) {
            Write-Step 'Launching P0 ASS/OSD probe'
            $env:IPTVNATOR_AI_CAPTION_P0_TEST = '1'
            Start-Process -FilePath $unpackedExe.FullName
            Write-Host 'Open any channel with Embedded MPV Native View.' -ForegroundColor Yellow
            Write-Host 'Expected: a fixed two-line bilingual overlay; the second line must render Simplified Chinese glyphs correctly.' -ForegroundColor Yellow
        }
    }

    Write-Host "`nWindows AI live-caption P0 smoke preparation completed successfully." -ForegroundColor Green
} finally {
    [IO.File]::WriteAllText($builderPath, $builderOriginal, $utf8NoBom)
    Pop-Location
}
