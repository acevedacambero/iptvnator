#include <windows.h>
#include <mpv/client.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <regex>

// No URL appears in arguments or logs. PCM goes to a parent-owned pipe;
// only numeric frame timestamps are forwarded from libavfilter's diagnostics.
int decodeCaptionAudio(int argc, wchar_t** argv)
{
    if (argc != 5) return 64;
    wchar_t executable[MAX_PATH]{};
    GetModuleFileNameW(nullptr, executable, MAX_PATH);
    std::wstring dll(executable);
    dll = dll.substr(0, dll.find_last_of(L"\\/")) + L"\\libmpv-2.dll";
    HMODULE library = LoadLibraryExW(dll.c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (!library) {
        dll = dll.substr(0, dll.find_last_of(L"\\/")) + L"\\mpv-2.dll";
        library = LoadLibraryExW(dll.c_str(), nullptr,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    }
    if (!library) return 2;
#define LOAD(name) auto name = reinterpret_cast<decltype(&::name)>(GetProcAddress(library, #name)); if (!name) return 2;
    LOAD(mpv_create)
    LOAD(mpv_set_option_string)
    LOAD(mpv_initialize)
    LOAD(mpv_command)
    LOAD(mpv_wait_event)
    LOAD(mpv_request_log_messages)
    LOAD(mpv_set_property_string)
    LOAD(mpv_get_property)
    LOAD(mpv_terminate_destroy)
#undef LOAD
    auto utf8 = [](const wchar_t* value) {
        const int count = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
        std::string result(count, '\0');
        WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), count, nullptr, nullptr);
        result.resize(count - 1);
        return result;
    };
    auto readLine = []() {
        std::string line;
        for (int ch; (ch = std::getchar()) != EOF && ch != '\n';) {
            if (line.size() > 65536) return std::string{};
            if (ch != '\r') line.push_back(static_cast<char>(ch));
        }
        return line;
    };
    const auto url = readLine();
    const auto userAgent = readLine();
    const auto referrer = readLine();
    const auto headers = readLine();
    if (url.empty()) return 64;
    mpv_handle* mpv = mpv_create();
    if (!mpv) return 2;
    bool valid = true;
    auto option = [&](const char* name, const std::string& value) {
        valid = mpv_set_option_string(mpv, name, value.c_str()) >= 0 && valid;
    };
    option("config", "no");
    option("terminal", "no");
    option("vid", "no");
    option("ao", "pcm");
    option("ao-pcm-file", utf8(argv[2]));
    option("ao-pcm-waveheader", "no");
    option("audio-format", "s16");
    option("audio-samplerate", "16000");
    option("audio-channels", "mono");
    option("af", "lavfi=[aformat=sample_fmts=s16:sample_rates=16000:channel_layouts=mono,asetnsamples=n=1600:p=0,ashowinfo]");
    option("msg-level", "all=no,ffmpeg=trace");
    option("rebase-start-time", "no");
    // ashowinfo timestamps precede mpv's output-stage seek trimming. Keep
    // every filtered sample in the PCM pipe, including coarse-seek preroll;
    // the parent discards frames before the visible player's source PTS.
    option("hr-seek", "no");
    option("initial-audio-sync", "no");
    option("start", utf8(argv[3]));
    option("aid", utf8(argv[4]));
    option("network-timeout", "10");
    if (!userAgent.empty()) option("user-agent", userAgent);
    if (!referrer.empty()) option("referrer", referrer);
    if (!headers.empty()) option("http-header-fields", headers);
    if (!valid || mpv_initialize(mpv) < 0) {
        mpv_terminate_destroy(mpv);
        return 2;
    }
    // Subscribe only to the selected module. All-module trace can overflow
    // libmpv's log queue during a fast HLS decode and lose frame timestamps.
    mpv_request_log_messages(mpv, "terminal-default");
    const char* load[] = {"loadfile", url.c_str(), nullptr};
    if (mpv_command(mpv, load) < 0) return 2;
    // The parent kills this private helper after closing the PCM pipe. EOF on
    // stdin is also a parent-lifetime guard, including an unexpected app exit.
    std::thread([=]() {
        for (;;) {
            const auto line = readLine();
            if (line == "pause" || line == "resume")
                mpv_set_property_string(mpv, "pause", line == "pause" ? "yes" : "no");
            else {
                const char* quit[] = {"quit", nullptr};
                mpv_command(mpv, quit);
                return;
            }
        }
    }).detach();
    const std::regex stamp("pts_time:([-+0-9.eE]+).*nb_samples:([0-9]+).*checksum:([0-9A-Fa-f]+)");
    for (;;) {
        mpv_event* event = mpv_wait_event(mpv, 0.1);
        if (event->event_id == MPV_EVENT_LOG_MESSAGE) {
            auto* log = static_cast<mpv_event_log_message*>(event->data);
            if (std::strcmp(log->prefix, "overflow") == 0) {
                std::fprintf(stderr, "{\"event\":\"end\",\"error\":-1}\n");
                std::fflush(stderr);
                return 2;
            }
            std::cmatch match;
            if (std::regex_search(log->text, match, stamp)) {
                std::fprintf(stderr, "{\"event\":\"frame\",\"pts\":%.6f,\"samples\":%d,\"checksum\":%lu}\n",
                    std::strtod(match[1].str().c_str(), nullptr), std::atoi(match[2].str().c_str()),
                    std::strtoul(match[3].str().c_str(), nullptr, 16));
                std::fflush(stderr);
            }
        } else if (event->event_id == MPV_EVENT_QUEUE_OVERFLOW) {
            std::fprintf(stderr, "{\"event\":\"end\",\"error\":-1}\n");
            std::fflush(stderr);
            return 2;
        } else if (event->event_id == MPV_EVENT_FILE_LOADED) {
            double start = 0;
            mpv_get_property(mpv, "demuxer-start-time", MPV_FORMAT_DOUBLE, &start);
            std::fprintf(stderr, "{\"event\":\"origin\",\"pts\":%.6f}\n", start);
            std::fflush(stderr);
        } else if (event->event_id == MPV_EVENT_END_FILE) {
            const auto* ended = static_cast<mpv_event_end_file*>(event->data);
            std::fprintf(stderr, "{\"event\":\"end\",\"error\":%d}\n", ended->error);
            std::fflush(stderr);
            break;
        } else if (event->event_id == MPV_EVENT_SHUTDOWN) break;
    }
    // The command-reader thread still holds this handle. Process teardown
    // releases it; destroying it here would race a simultaneous stdin command.
    return 0;
}
