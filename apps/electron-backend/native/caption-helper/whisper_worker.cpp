#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

#include "whisper.h"
#include "ggml-backend.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr uint32_t kMaxPcmBytes = 16'000 * 2 * 12; // 12 s, s16le mono
constexpr int kDefaultMaxTokens = 128;

uint32_t decodeLe32(const unsigned char bytes[4])
{
    return static_cast<uint32_t>(bytes[0]) |
        (static_cast<uint32_t>(bytes[1]) << 8) |
        (static_cast<uint32_t>(bytes[2]) << 16) |
        (static_cast<uint32_t>(bytes[3]) << 24);
}

bool readExact(void* output, size_t size)
{
    auto* cursor = static_cast<unsigned char*>(output);
    size_t received = 0;
    while (received < size) {
        const size_t count = std::fread(cursor + received, 1, size - received, stdin);
        if (count == 0) {
            return false;
        }
        received += count;
    }
    return true;
}

std::string jsonEscape(const std::string& input)
{
    std::string output;
    output.reserve(input.size() + 16);
    static const char* hex = "0123456789abcdef";
    for (const unsigned char value : input) {
        switch (value) {
        case '\\':
            output += "\\\\";
            break;
        case '"':
            output += "\\\"";
            break;
        case '\b':
            output += "\\b";
            break;
        case '\f':
            output += "\\f";
            break;
        case '\n':
            output += "\\n";
            break;
        case '\r':
            output += "\\r";
            break;
        case '\t':
            output += "\\t";
            break;
        default:
            if (value < 0x20) {
                output += "\\u00";
                output += hex[(value >> 4) & 0x0f];
                output += hex[value & 0x0f];
            } else {
                output.push_back(static_cast<char>(value));
            }
            break;
        }
    }
    return output;
}

std::string trimText(std::string value)
{
    const auto isSpace = [](unsigned char ch) {
        return ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n';
    };
    while (!value.empty() && isSpace(static_cast<unsigned char>(value.front()))) {
        value.erase(value.begin());
    }
    while (!value.empty() && isSpace(static_cast<unsigned char>(value.back()))) {
        value.pop_back();
    }
    return value;
}

int parsePositiveInt(const char* value, int fallback)
{
    if (!value || !*value) {
        return fallback;
    }
    char* end = nullptr;
    const long parsed = std::strtol(value, &end, 10);
    if (!end || *end != '\0' || parsed <= 0 || parsed > 256) {
        return fallback;
    }
    return static_cast<int>(parsed);
}

void emitError(uint32_t requestId, const char* code, const std::string& message)
{
    std::fprintf(
        stdout,
        "{\"id\":%u,\"ok\":false,\"error\":\"%s\",\"message\":\"%s\"}\n",
        requestId,
        code,
        jsonEscape(message).c_str()
    );
    std::fflush(stdout);
}

void emitReady(const char* modelPath, int threads, const char* backend)
{
    std::fprintf(
        stdout,
        "{\"event\":\"ready\",\"model\":\"%s\",\"sampleRate\":%d,\"threads\":%d,\"backend\":\"%s\"}\n",
        jsonEscape(modelPath).c_str(),
        WHISPER_SAMPLE_RATE,
        threads,
        backend
    );
    std::fflush(stdout);
}

void emitResult(uint32_t requestId, const std::string& text, int elapsedMs, whisper_context* context)
{
    std::fprintf(
        stdout,
        "{\"id\":%u,\"ok\":true,\"text\":\"%s\",\"elapsedMs\":%d,\"tokens\":[",
        requestId,
        jsonEscape(text).c_str(),
        elapsedMs
    );
    bool first = true;
    std::string pending;
    int64_t pendingStart = 0, pendingEnd = 0;
    auto completeUtf8 = [](const std::string& value) {
        size_t remaining = 0;
        for (unsigned char ch : value) {
            if (remaining) { if ((ch & 0xc0) != 0x80) return false; --remaining; }
            else if (ch < 0x80) continue;
            else if ((ch & 0xe0) == 0xc0) remaining = 1;
            else if ((ch & 0xf0) == 0xe0) remaining = 2;
            else if ((ch & 0xf8) == 0xf0) remaining = 3;
            else return false;
        }
        return remaining == 0;
    };
    for (int segment = 0; segment < whisper_full_n_segments(context); ++segment) {
        for (int token = 0; token < whisper_full_n_tokens(context, segment); ++token) {
            const auto data = whisper_full_get_token_data(context, segment, token);
            if (data.id >= whisper_token_eot(context) || data.t0 < 0 || data.t1 < data.t0) continue;
            const char* tokenText = whisper_full_get_token_text(context, segment, token);
            if (!tokenText) continue;
            // BPE can split a Unicode character across tokens. Do not emit
            // invalid UTF-8 JSON strings, which turn music symbols into U+FFFD.
            if (pending.empty()) pendingStart = data.t0 * 10;
            pending += tokenText;
            pendingEnd = data.t1 * 10;
            if (!completeUtf8(pending)) continue;
            std::fprintf(stdout, "%s{\"text\":\"%s\",\"startMs\":%lld,\"endMs\":%lld}",
                first ? "" : ",", jsonEscape(pending).c_str(),
                static_cast<long long>(pendingStart), static_cast<long long>(pendingEnd));
            pending.clear();
            first = false;
        }
    }
    std::fprintf(stdout, "]}\n");
    std::fflush(stdout);
}

struct Options {
    std::string modelPath;
    int threads = 0;
};

bool parseArgs(int argc, char** argv, Options& options)
{
    const unsigned int hardwareThreads = std::thread::hardware_concurrency();
    options.threads = std::max(
        1,
        std::min(8, hardwareThreads == 0 ? 4 : static_cast<int>(hardwareThreads))
    );

    for (int index = 1; index < argc; ++index) {
        if (std::strcmp(argv[index], "--model") == 0 && index + 1 < argc) {
            options.modelPath = argv[++index];
            continue;
        }
        if (std::strcmp(argv[index], "--threads") == 0 && index + 1 < argc) {
            options.threads = parsePositiveInt(argv[++index], options.threads);
            continue;
        }
        return false;
    }
    return !options.modelPath.empty();
}

std::vector<float> pcm16ToFloat(const std::vector<int16_t>& pcm)
{
    std::vector<float> samples;
    samples.reserve(pcm.size());
    constexpr float scale = 1.0f / 32768.0f;
    for (const int16_t value : pcm) {
        samples.push_back(static_cast<float>(value) * scale);
    }
    return samples;
}

std::string collectText(whisper_context* context)
{
    std::string text;
    const int segmentCount = whisper_full_n_segments(context);
    for (int index = 0; index < segmentCount; ++index) {
        const char* segment = whisper_full_get_segment_text(context, index);
        if (segment) {
            text += segment;
        }
    }
    return trimText(text);
}

} // namespace

int main(int argc, char** argv)
{
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    Options options;
    if (!parseArgs(argc, argv, options)) {
        std::fprintf(
            stderr,
            "Usage: iptvnator_whisper_helper --model <ggml-model.bin> [--threads N]\n"
        );
        return 64;
    }

    whisper_context_params contextParams = whisper_context_default_params();
    const char* requestedDevice = std::getenv("IPTVNATOR_WHISPER_DEVICE");
    if (requestedDevice && std::strcmp(requestedDevice, "cpu") != 0 &&
        std::strcmp(requestedDevice, "cuda") != 0) {
        std::fprintf(stderr, "IPTVNATOR_WHISPER_DEVICE must be cpu or cuda.\n");
        return 64;
    }
    contextParams.use_gpu = false;
#ifdef IPTVNATOR_WHISPER_CUDA
    contextParams.use_gpu = !requestedDevice || std::strcmp(requestedDevice, "cpu") != 0;
#endif
    contextParams.flash_attn = false;

    ggml_backend_load_all();
    bool cudaAvailable = false;
    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        auto device = ggml_backend_dev_get(i);
        cudaAvailable = cudaAvailable ||
            (ggml_backend_dev_type(device) == GGML_BACKEND_DEVICE_TYPE_GPU &&
             std::strcmp(ggml_backend_reg_name(ggml_backend_dev_backend_reg(device)), "CUDA") == 0);
    }
    if (requestedDevice && std::strcmp(requestedDevice, "cuda") == 0 &&
        (!contextParams.use_gpu || !cudaAvailable)) {
        std::fprintf(stderr, "The requested CUDA caption device is unavailable.\n");
        return 3;
    }
    contextParams.use_gpu = contextParams.use_gpu && cudaAvailable;

    whisper_context* context = whisper_init_from_file_with_params(
        options.modelPath.c_str(),
        contextParams
    );
    if (!context) {
        std::fprintf(stderr, "Unable to load whisper model: %s\n", options.modelPath.c_str());
        return 2;
    }

    emitReady(options.modelPath.c_str(), options.threads, contextParams.use_gpu ? "CUDA" : "CPU");

    std::string previousPrompt;
    while (true) {
        unsigned char header[8]{};
        if (!readExact(header, sizeof(header))) {
            break;
        }
        const uint32_t requestId = decodeLe32(header);
        const uint32_t pcmBytes = decodeLe32(header + 4);
        if (pcmBytes == 0 || pcmBytes > kMaxPcmBytes || (pcmBytes % 2) != 0) {
            emitError(requestId, "invalid-pcm-size", "PCM payload size is invalid.");
            if (pcmBytes > 0 && pcmBytes <= kMaxPcmBytes) {
                std::vector<unsigned char> discard(pcmBytes);
                if (!readExact(discard.data(), discard.size())) {
                    break;
                }
            } else {
                break;
            }
            continue;
        }

        std::vector<int16_t> pcm(pcmBytes / 2);
        if (!readExact(pcm.data(), pcmBytes)) {
            break;
        }
        const std::vector<float> samples = pcm16ToFloat(pcm);

        whisper_full_params params = whisper_full_default_params(
            WHISPER_SAMPLING_BEAM_SEARCH
        );
        params.beam_search.beam_size = 3;
        params.initial_prompt = previousPrompt.empty() ? nullptr : previousPrompt.c_str();
        params.n_threads = options.threads;
        params.translate = false;
        params.no_context = true;
        params.no_timestamps = false;
        params.single_segment = false;
        params.print_special = false;
        params.print_progress = false;
        params.print_realtime = false;
        params.print_timestamps = false;
        params.token_timestamps = true;
        params.max_tokens = kDefaultMaxTokens;
        params.language = "en";
        params.detect_language = false;
        params.suppress_blank = true;
        params.suppress_nst = true;
        params.temperature_inc = -1.0f;

        const auto started = std::chrono::steady_clock::now();
        const int result = whisper_full(
            context,
            params,
            samples.data(),
            static_cast<int>(samples.size())
        );
        const int elapsedMs = static_cast<int>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - started
            ).count()
        );
        if (result != 0) {
            emitError(requestId, "inference-failed", "whisper_full returned an error.");
            continue;
        }

        const auto text = collectText(context);
        emitResult(requestId, text, elapsedMs, context);
        previousPrompt = text.size() <= 320 ? text : text.substr(text.size() - 320);
    }

    whisper_free(context);
    return 0;
}
