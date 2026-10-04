---
type: fix
area: playback
---

Windows AI captions retain the correct audio timestamps after starting or resuming a live stream, fixing subtitles that appear several seconds before the corresponding speech. Audio frames are checked against their timestamps to prevent silent synchronization drift.
