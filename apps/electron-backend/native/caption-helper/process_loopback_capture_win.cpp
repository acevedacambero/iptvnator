#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <Windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <propidl.h>
#include <winternl.h>
#include <wrl.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <string>
#include <vector>

using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

namespace {

constexpr DWORD kMinimumProcessLoopbackBuild = 20348;
constexpr DWORD kCaptureSampleRate = 16000;
constexpr WORD kCaptureChannels = 1;
constexpr WORD kCaptureBitsPerSample = 16;
constexpr UINT64 kQpc100nsPerSecond = 10000000ULL;
constexpr UINT64 kClockTelemetryInterval100ns = 2500000ULL;

class ScopedHandle {
public:
    ScopedHandle() = default;
    explicit ScopedHandle(HANDLE handle) : handle_(handle) {}
    ~ScopedHandle() { reset(); }

    ScopedHandle(const ScopedHandle&) = delete;
    ScopedHandle& operator=(const ScopedHandle&) = delete;

    HANDLE get() const { return handle_; }
    bool valid() const { return handle_ && handle_ != INVALID_HANDLE_VALUE; }

    void reset(HANDLE next = nullptr)
    {
        if (valid()) {
            CloseHandle(handle_);
        }
        handle_ = next;
    }

private:
    HANDLE handle_ = nullptr;
};

struct ClockTelemetry {
    UINT64 capturedFrames = 0;
    UINT64 lastEmittedQpc100ns = 0;
};

DWORD currentWindowsBuild()
{
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) {
        return 0;
    }
    using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    auto rtlGetVersion = reinterpret_cast<RtlGetVersionFn>(
        GetProcAddress(ntdll, "RtlGetVersion")
    );
    if (!rtlGetVersion) {
        return 0;
    }
    RTL_OSVERSIONINFOW info{};
    info.dwOSVersionInfoSize = sizeof(info);
    return rtlGetVersion(&info) == 0 ? info.dwBuildNumber : 0;
}

std::string hresultHex(HRESULT hr)
{
    char buffer[32]{};
    std::snprintf(
        buffer,
        sizeof(buffer),
        "0x%08lX",
        static_cast<unsigned long>(hr)
    );
    return buffer;
}

void emitError(const char* stage, HRESULT hr)
{
    std::fprintf(
        stderr,
        "{\"event\":\"error\",\"stage\":\"%s\",\"hresult\":\"%s\"}\n",
        stage,
        hresultHex(hr).c_str()
    );
    std::fflush(stderr);
}

void emitUnsupported(DWORD build)
{
    std::fprintf(
        stderr,
        "{\"event\":\"unsupported\",\"reason\":\"process-loopback-build\",\"build\":%lu,\"minimumBuild\":%lu}\n",
        static_cast<unsigned long>(build),
        static_cast<unsigned long>(kMinimumProcessLoopbackBuild)
    );
    std::fflush(stderr);
}

void emitClock(
    UINT64 qpcEnd100ns,
    UINT64 devicePositionEndFrames,
    UINT64 capturedFrames
)
{
    std::fprintf(
        stderr,
        "{\"event\":\"clock\",\"qpcEnd100ns\":%llu,\"devicePositionEndFrames\":%llu,\"capturedFrames\":%llu}\n",
        static_cast<unsigned long long>(qpcEnd100ns),
        static_cast<unsigned long long>(devicePositionEndFrames),
        static_cast<unsigned long long>(capturedFrames)
    );
    std::fflush(stderr);
}

class ActivationHandler final : public RuntimeClass<
                                    RuntimeClassFlags<ClassicCom>,
                                    FtmBase,
                                    IActivateAudioInterfaceCompletionHandler> {
public:
    ActivationHandler()
    {
        completed_.reset(CreateEventW(nullptr, FALSE, FALSE, nullptr));
    }

    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override
    {
        HRESULT activationHr = E_UNEXPECTED;
        ComPtr<IUnknown> activated;
        HRESULT hr = operation->GetActivateResult(&activationHr, &activated);
        if (SUCCEEDED(hr)) {
            hr = activationHr;
        }
        if (SUCCEEDED(hr)) {
            hr = activated.As(&audioClient_);
        }
        result_ = hr;
        if (completed_.valid()) {
            SetEvent(completed_.get());
        }
        return S_OK;
    }

    HRESULT wait(ComPtr<IAudioClient>& audioClient)
    {
        if (!completed_.valid()) {
            return HRESULT_FROM_WIN32(GetLastError());
        }
        const DWORD waitResult = WaitForSingleObject(completed_.get(), 5000);
        if (waitResult != WAIT_OBJECT_0) {
            return waitResult == WAIT_TIMEOUT
                       ? HRESULT_FROM_WIN32(ERROR_TIMEOUT)
                       : HRESULT_FROM_WIN32(GetLastError());
        }
        if (SUCCEEDED(result_)) {
            audioClient = audioClient_;
        }
        return result_;
    }

private:
    ScopedHandle completed_;
    HRESULT result_ = E_PENDING;
    ComPtr<IAudioClient> audioClient_;
};

HRESULT activateProcessLoopback(DWORD targetPid, ComPtr<IAudioClient>& audioClient)
{
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = targetPid;
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT activationParams{};
    activationParams.vt = VT_BLOB;
    activationParams.blob.cbSize = sizeof(params);
    activationParams.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    auto handler = Microsoft::WRL::Make<ActivationHandler>();
    if (!handler) {
        return E_OUTOFMEMORY;
    }

    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activationParams,
        handler.Get(),
        &operation
    );
    if (FAILED(hr)) {
        return hr;
    }
    return handler->wait(audioClient);
}

HRESULT initializeCapture(
    IAudioClient* audioClient,
    HANDLE sampleReadyEvent,
    ComPtr<IAudioCaptureClient>& captureClient
)
{
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = kCaptureChannels;
    format.nSamplesPerSec = kCaptureSampleRate;
    format.wBitsPerSample = kCaptureBitsPerSample;
    format.nBlockAlign =
        format.nChannels * format.wBitsPerSample / static_cast<WORD>(8);
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

    const DWORD streamFlags =
        AUDCLNT_STREAMFLAGS_LOOPBACK |
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

    HRESULT hr = audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        streamFlags,
        0,
        0,
        &format,
        nullptr
    );
    if (FAILED(hr)) {
        return hr;
    }

    hr = audioClient->GetService(IID_PPV_ARGS(&captureClient));
    if (FAILED(hr)) {
        return hr;
    }
    return audioClient->SetEventHandle(sampleReadyEvent);
}

bool writeAll(HANDLE output, const BYTE* data, DWORD byteCount)
{
    DWORD offset = 0;
    while (offset < byteCount) {
        DWORD written = 0;
        if (!WriteFile(output, data + offset, byteCount - offset, &written, nullptr)) {
            return false;
        }
        if (written == 0) {
            return false;
        }
        offset += written;
    }
    return true;
}

HRESULT drainCapture(
    IAudioCaptureClient* captureClient,
    HANDLE output,
    ClockTelemetry& telemetry
)
{
    UINT32 packetFrames = 0;
    HRESULT hr = captureClient->GetNextPacketSize(&packetFrames);
    if (FAILED(hr)) {
        return hr;
    }

    std::vector<BYTE> silence;
    while (packetFrames > 0) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        UINT64 devicePosition = 0;
        UINT64 qpcPosition100ns = 0;
        hr = captureClient->GetBuffer(
            &data,
            &frames,
            &flags,
            &devicePosition,
            &qpcPosition100ns
        );
        if (FAILED(hr)) {
            return hr;
        }

        const DWORD byteCount = frames * kCaptureChannels *
            (kCaptureBitsPerSample / static_cast<WORD>(8));
        bool writeOk = true;
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || !data) {
            silence.assign(byteCount, 0);
            writeOk = writeAll(output, silence.data(), byteCount);
        } else {
            writeOk = writeAll(output, data, byteCount);
        }

        telemetry.capturedFrames += frames;
        const bool timestampValid =
            (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) == 0 &&
            qpcPosition100ns > 0;
        const UINT64 frameDuration100ns =
            (static_cast<UINT64>(frames) * kQpc100nsPerSecond) /
            kCaptureSampleRate;
        const UINT64 qpcEnd100ns = qpcPosition100ns + frameDuration100ns;
        const UINT64 devicePositionEndFrames = devicePosition + frames;

        const HRESULT releaseHr = captureClient->ReleaseBuffer(frames);
        if (!writeOk) {
            return HRESULT_FROM_WIN32(ERROR_BROKEN_PIPE);
        }
        if (FAILED(releaseHr)) {
            return releaseHr;
        }

        if (
            timestampValid &&
            (telemetry.lastEmittedQpc100ns == 0 ||
             qpcEnd100ns - telemetry.lastEmittedQpc100ns >=
                 kClockTelemetryInterval100ns)
        ) {
            emitClock(
                qpcEnd100ns,
                devicePositionEndFrames,
                telemetry.capturedFrames
            );
            telemetry.lastEmittedQpc100ns = qpcEnd100ns;
        }

        hr = captureClient->GetNextPacketSize(&packetFrames);
        if (FAILED(hr)) {
            return hr;
        }
    }
    return S_OK;
}

DWORD parsePid(const wchar_t* value)
{
    if (!value || !*value) {
        return 0;
    }
    wchar_t* end = nullptr;
    const unsigned long parsed = std::wcstoul(value, &end, 10);
    return end && *end == L'\0' ? static_cast<DWORD>(parsed) : 0;
}

} // namespace

int decodeCaptionAudio(int argc, wchar_t** argv);

int wmain(int argc, wchar_t** argv)
{
    if (argc > 1 && std::wcscmp(argv[1], L"--decode") == 0)
        return decodeCaptionAudio(argc, argv);
    if (argc != 3 || std::wstring(argv[1]) != L"--pid") {
        std::fprintf(stderr, "Usage: iptvnator_caption_helper --pid <process-id>\n");
        return 64;
    }

    const DWORD targetPid = parsePid(argv[2]);
    if (targetPid == 0) {
        std::fprintf(stderr, "Invalid target process id.\n");
        return 64;
    }

    const DWORD build = currentWindowsBuild();
    if (build != 0 && build < kMinimumProcessLoopbackBuild) {
        emitUnsupported(build);
        return 2;
    }

    const HRESULT comHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(comHr) && comHr != RPC_E_CHANGED_MODE) {
        emitError("CoInitializeEx", comHr);
        return 1;
    }

    ComPtr<IAudioClient> audioClient;
    HRESULT hr = activateProcessLoopback(targetPid, audioClient);
    if (FAILED(hr)) {
        emitError("ActivateAudioInterfaceAsync", hr);
        if (SUCCEEDED(comHr)) {
            CoUninitialize();
        }
        return 1;
    }

    ScopedHandle sampleReady(CreateEventW(nullptr, FALSE, FALSE, nullptr));
    if (!sampleReady.valid()) {
        emitError("CreateEvent", HRESULT_FROM_WIN32(GetLastError()));
        if (SUCCEEDED(comHr)) {
            CoUninitialize();
        }
        return 1;
    }

    ComPtr<IAudioCaptureClient> captureClient;
    hr = initializeCapture(audioClient.Get(), sampleReady.get(), captureClient);
    if (FAILED(hr)) {
        emitError("IAudioClient::Initialize", hr);
        if (SUCCEEDED(comHr)) {
            CoUninitialize();
        }
        return 1;
    }

    ScopedHandle targetProcess(OpenProcess(SYNCHRONIZE, FALSE, targetPid));
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!targetProcess.valid() || !output || output == INVALID_HANDLE_VALUE) {
        emitError("OpenProcess/stdout", HRESULT_FROM_WIN32(GetLastError()));
        if (SUCCEEDED(comHr)) {
            CoUninitialize();
        }
        return 1;
    }

    hr = audioClient->Start();
    if (FAILED(hr)) {
        emitError("IAudioClient::Start", hr);
        if (SUCCEEDED(comHr)) {
            CoUninitialize();
        }
        return 1;
    }

    std::fprintf(
        stderr,
        "{\"event\":\"ready\",\"sampleRate\":%lu,\"channels\":%u,\"format\":\"s16le\",\"targetPid\":%lu}\n",
        static_cast<unsigned long>(kCaptureSampleRate),
        static_cast<unsigned int>(kCaptureChannels),
        static_cast<unsigned long>(targetPid)
    );
    std::fflush(stderr);

    ClockTelemetry clockTelemetry;
    HANDLE waitHandles[] = { sampleReady.get(), targetProcess.get() };
    int exitCode = 0;
    while (true) {
        const DWORD waitResult = WaitForMultipleObjects(2, waitHandles, FALSE, INFINITE);
        if (waitResult == WAIT_OBJECT_0 + 1) {
            break;
        }
        if (waitResult != WAIT_OBJECT_0) {
            emitError("WaitForMultipleObjects", HRESULT_FROM_WIN32(GetLastError()));
            exitCode = 1;
            break;
        }
        hr = drainCapture(captureClient.Get(), output, clockTelemetry);
        if (FAILED(hr)) {
            // A broken stdout pipe simply means the parent stopped captions.
            if (hr != HRESULT_FROM_WIN32(ERROR_BROKEN_PIPE) &&
                hr != HRESULT_FROM_WIN32(ERROR_NO_DATA)) {
                emitError("IAudioCaptureClient", hr);
                exitCode = 1;
            }
            break;
        }
    }

    audioClient->Stop();
    if (SUCCEEDED(comHr)) {
        CoUninitialize();
    }
    return exitCode;
}
