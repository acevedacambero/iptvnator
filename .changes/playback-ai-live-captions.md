---
type: feature
area: playback
highlight: AI live captions
---

On Windows x64, Embedded MPV native-view playback can now generate live English captions locally with a pinned Whisper model and optionally add Chinese translation through a securely stored OpenAI-compatible provider. Translation is a separate, non-blocking stage: playback and English captions keep running if the translation provider is slow, unavailable, or misconfigured.
