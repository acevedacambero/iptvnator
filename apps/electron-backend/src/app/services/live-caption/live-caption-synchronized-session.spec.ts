import { LiveCaptionSynchronizedSession } from './live-caption-synchronized-session';
import type { CaptionAudioFrame } from './live-caption-decoded-audio-source';
import { liveCaptionTranslationSettingsStore } from './live-caption-translation-settings.store';
import type { AiCaptionAssStyle } from './ai-caption-ass';

let mockDisplayStyle: Partial<AiCaptionAssStyle> = {};

let mockOnFrame: (frame: CaptionAudioFrame) => void;
const mockAudio = {
    start: jest.fn(async (_context, onFrame) => {
        mockOnFrame = onFrame;
    }),
    setPaused: jest.fn(),
    stop: jest.fn(),
};
const mockWhisper = {
    start: jest.fn().mockResolvedValue({}),
    stop: jest.fn(),
    transcribe: jest.fn().mockResolvedValue({
        text: 'A clear sentence.',
        elapsedMs: 200,
        tokens: [
            { text: ' A', startMs: 1000, endMs: 1300 },
            { text: ' clear', startMs: 1400, endMs: 1700 },
            { text: ' sentence.', startMs: 1800, endMs: 2200 },
        ],
    }),
};
const mockTranslator = {
    translate: jest
        .fn()
        .mockResolvedValue({ text: '清楚的一句话。', elapsedMs: 100 }),
    stop: jest.fn(),
};
const mockPlayer = {
    getCaptionPlaybackContext: jest.fn().mockResolvedValue({
        source: 'https://example.test/live.m3u8',
        origin: 100,
        position: 0,
        aid: '1',
        userAgent: '',
        referrer: '',
        headers: '',
        paused: false,
    }),
    getPlaybackPositionSeconds: jest.fn().mockResolvedValue(0),
    setCaptionBuffering: jest.fn().mockResolvedValue(undefined),
    alignCaptionPlayback: jest.fn().mockResolvedValue(undefined),
    setOverlay: jest.fn().mockResolvedValue(undefined),
    clearOverlay: jest.fn().mockResolvedValue(undefined),
};
jest.mock('./live-caption-decoded-audio-source', () => ({
    LiveCaptionDecodedAudioSource: jest.fn(() => mockAudio),
}));
jest.mock('./live-caption-whisper-client', () => ({
    LiveCaptionWhisperClient: jest.fn(() => mockWhisper),
}));
jest.mock('./live-caption-translator', () => ({
    LiveCaptionTranslator: jest.fn(() => mockTranslator),
}));
jest.mock('./live-caption-mpv-overlay.service', () => ({
    liveCaptionMpvOverlayService: new Proxy(
        {},
        {
            get: (_target, key: string) =>
                mockPlayer[key as keyof typeof mockPlayer],
        }
    ),
}));
jest.mock('./live-caption-display-settings.store', () => ({
    liveCaptionDisplaySettingsStore: { getAssStyle: () => mockDisplayStyle },
}));
jest.mock('./live-caption-translation-settings.store', () => ({
    liveCaptionTranslationSettingsStore: {
        resolveForSession: () => ({ enabled: true }),
    },
}));

describe('synchronized caption pipeline', () => {
    let current: boolean;
    let session: LiveCaptionSynchronizedSession;
    const failed = jest.fn();
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        current = true;
        mockDisplayStyle = {};
        mockPlayer.getPlaybackPositionSeconds.mockResolvedValue(0);
        mockTranslator.translate.mockResolvedValue({
            text: '清楚的一句话。',
            elapsedMs: 100,
        });
        session = new LiveCaptionSynchronizedSession(
            'session',
            () => current,
            jest.fn(),
            failed
        );
    });
    afterEach(async () => {
        await session.stop();
        jest.useRealTimers();
    });
    function feed(start: number, count: number): void {
        const pcm = Buffer.alloc(3200);
        for (let offset = 0; offset < pcm.length; offset += 2)
            pcm.writeInt16LE(1000, offset);
        for (let index = 0; index < count; index++)
            mockOnFrame({
                pcm,
                pts: start + index / 10,
                end: start + (index + 1) / 10,
            });
    }
    it('waits for complete bilingual coverage, then paints according to video PTS', async () => {
        await session.start('model', {});
        expect(mockPlayer.setCaptionBuffering).toHaveBeenCalledWith(
            'session',
            true
        );
        feed(100, 160);
        await jest.advanceTimersByTimeAsync(120);
        expect(mockPlayer.setCaptionBuffering).not.toHaveBeenCalledWith(
            'session',
            false
        );
        expect(mockPlayer.setOverlay).not.toHaveBeenCalled();
        feed(116, 80);
        await jest.advanceTimersByTimeAsync(120);
        expect(mockPlayer.setCaptionBuffering).toHaveBeenCalledWith(
            'session',
            false
        );
        mockPlayer.getPlaybackPositionSeconds.mockResolvedValue(1.1);
        await jest.advanceTimersByTimeAsync(120);
        expect(
            mockPlayer.setOverlay.mock.calls.at(-1)?.[1].assEvents
        ).toContain('清楚的一句话。');
        expect(session.snapshot().syncTelemetry?.clockSource).toBe('media-pts');
        expect(failed).not.toHaveBeenCalled();
    });
    it('does not resume a user pause when captions stop during buffering', async () => {
        await session.start('model', {});
        session.setUserPaused(true);
        await session.stop();
        expect(mockPlayer.setCaptionBuffering).not.toHaveBeenCalledWith(
            'session',
            false
        );
    });
    it('redraws the current bilingual cue with saved appearance without restarting recognition', async () => {
        await session.start('model', {});
        feed(100, 240);
        await jest.advanceTimersByTimeAsync(120);
        mockPlayer.getPlaybackPositionSeconds.mockResolvedValue(1.1);
        await jest.advanceTimersByTimeAsync(120);
        const calls = mockWhisper.transcribe.mock.calls.length;
        mockDisplayStyle = {
            alignment: 'left',
            sourceColor: '#FFE066',
            translatedColor: '#66D9FF',
            sourceFontSize: 64,
            translatedFontSize: 72,
            sourceY: 680,
            translatedY: 772,
        };
        await session.redraw();
        const [source, translated] = mockPlayer.setOverlay.mock.calls
            .at(-1)?.[1]
            .assEvents.split('\n');
        expect(source).toContain('\\an1\\pos(80,680)\\fs64');
        expect(source).toContain('\\1c&H0066E0FF&');
        expect(translated).toContain('\\pos(80,772)\\fs72');
        expect(translated).toContain('\\1c&H00FFD966&');
        expect(mockWhisper.start).toHaveBeenCalledTimes(1);
        expect(mockWhisper.transcribe).toHaveBeenCalledTimes(calls);
        expect(failed).not.toHaveBeenCalled();
    });
    it('continues with synchronized English if translation configuration cannot be loaded', async () => {
        jest.spyOn(
            liveCaptionTranslationSettingsStore,
            'resolveForSession'
        ).mockImplementationOnce(() => {
            throw new Error('Translation settings are unavailable.');
        });
        await session.start('model', {});
        feed(100, 240);
        await jest.advanceTimersByTimeAsync(120);
        mockPlayer.getPlaybackPositionSeconds.mockResolvedValue(1.1);
        await jest.advanceTimersByTimeAsync(120);
        expect(mockPlayer.setOverlay).toHaveBeenCalled();
        expect(session.snapshot().translationError).toContain(
            'settings are unavailable'
        );
        expect(mockTranslator.translate).not.toHaveBeenCalled();
        expect(failed).not.toHaveBeenCalled();
    });
    it('releases its own buffering pause when captions are disabled', async () => {
        await session.start('model', {});
        await session.stop();
        expect(mockPlayer.setCaptionBuffering).toHaveBeenLastCalledWith(
            'session',
            false
        );
    });
    it('ignores translation completion after a stopped generation', async () => {
        let finish!: (value: { text: string; elapsedMs: number }) => void;
        mockTranslator.translate.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        await session.start('model', {});
        feed(100, 160);
        await jest.advanceTimersByTimeAsync(60);
        current = false;
        await session.stop();
        finish({ text: '过期翻译', elapsedMs: 500 });
        await jest.advanceTimersByTimeAsync(120);
        expect(mockPlayer.setOverlay).not.toHaveBeenCalled();
        expect(failed).not.toHaveBeenCalled();
    });
    it('finishes right context instead of deadlocking at the decoder lead cap', async () => {
        await session.start('model', {});
        feed(100, 160);
        await jest.advanceTimersByTimeAsync(120);
        feed(116, 81);
        await jest.advanceTimersByTimeAsync(120);
        // A resumed schedule can pause at its cap; a held schedule needing
        // another utterance must be allowed to receive the final PCM frames.
        const internal = session as unknown as {
            schedule: { held: boolean };
            queue: unknown[];
            decodedThrough: number;
            position: number;
            decoderShouldPause(): boolean;
        };
        internal.schedule.held = true;
        internal.queue = [{}];
        internal.decodedThrough = 124;
        internal.position = 100;
        expect(internal.decoderShouldPause()).toBe(false);
        internal.queue = [{}, {}, {}];
        expect(internal.decoderShouldPause()).toBe(true);
    });
});
