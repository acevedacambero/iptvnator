---
type: feature
area: playback
highlight: AI live captions
---

On Windows x64, Embedded MPV native-view playback can now generate live English captions locally with a pinned Whisper model and optionally add Simplified Chinese translation. Google Translate's keyless free web endpoint is available as the default best-effort provider, while OpenAI-compatible providers remain supported with securely stored credentials. AI captions render as white text with a black outline in stable CC-style lines instead of continuously repainting a growing transcript; font size and vertical position are style parameters for the follow-up settings UI. Translation remains a separate, non-blocking stage: playback and English captions keep running if translation is slow, unavailable, rate-limited, or misconfigured.
