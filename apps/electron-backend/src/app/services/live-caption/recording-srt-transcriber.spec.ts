import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecordingSrtTranscriber } from './recording-srt-transcriber';
import type { CaptionAudioFrame } from './live-caption-decoded-audio-source';
const mockAudio = { start: jest.fn(), stop: jest.fn(), setPaused: jest.fn() };
const mockWhisper = {
    start: jest.fn(),
    transcribe: jest.fn(),
    stop: jest.fn(),
};
const mockTranslate = { prepare: jest.fn(), stop: jest.fn() };
jest.mock('./live-caption-decoded-audio-source', () => ({
    LiveCaptionDecodedAudioSource: jest.fn(() => mockAudio),
}));
jest.mock('./live-caption-whisper-pool', () => ({
    SharedWhisperLease: jest.fn(() => mockWhisper),
}));
jest.mock('./live-caption-cue-translator', () => ({
    LiveCaptionCueTranslator: jest.fn(() => mockTranslate),
}));
jest.mock('./recording-ts-clock', () => ({
    readRecordingTsClock: jest.fn().mockResolvedValue({ start: 10, end: 11 }),
}));
describe('recording transcription', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockWhisper.start.mockResolvedValue({});
        mockWhisper.transcribe.mockResolvedValue({ text: 'Hello' });
        mockTranslate.prepare.mockImplementation(async (cues) => {
            for (const cue of cues) cue.translated = '你好';
        });
        mockAudio.start.mockImplementation(
            async (
                _context,
                onFrame: (frame: CaptionAudioFrame) => void,
                _onError,
                onEnd
            ) => {
                const pcm = Buffer.alloc(3200);
                for (let offset = 0; offset < pcm.length; offset += 2)
                    pcm.writeInt16LE(1000, offset);
                for (let index = 0; index < 10; index++)
                    onFrame({
                        pcm,
                        pts: 10 + index / 10,
                        end: 10 + (index + 1) / 10,
                    });
                onEnd();
            }
        );
    });
    async function output(
        test: (
            file: Awaited<ReturnType<typeof open>>,
            target: string
        ) => Promise<void>
    ) {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'iptvnator-srt-'));
        const target = path.join(dir, 'record.srt');
        const file = await open(target, 'wx');
        try {
            await test(file, target);
        } finally {
            await file.close();
            await rm(dir, { recursive: true, force: true });
        }
    }
    it('flushes a short EOF chunk and writes bilingual timestamps relative to the saved video', async () => {
        await output(async (file, target) => {
            const progress = jest.fn();
            expect(
                await new RecordingSrtTranscriber().run(
                    'record.ts',
                    'model',
                    {},
                    file,
                    progress
                )
            ).toBe(0);
            expect(await readFile(target, 'utf8')).toBe(
                '1\r\n00:00:00,000 --> 00:00:01,000\r\nHello\r\n你好\r\n\r\n'
            );
            expect(progress).toHaveBeenLastCalledWith(100);
            expect(mockAudio.stop).toHaveBeenCalled();
            expect(mockWhisper.stop).toHaveBeenCalled();
            expect(mockTranslate.stop).toHaveBeenCalled();
        });
    });
    it('retains English and reports untranslated cues', async () => {
        mockTranslate.prepare.mockResolvedValue(undefined);
        await output(async (file, target) => {
            expect(
                await new RecordingSrtTranscriber().run(
                    'record.ts',
                    'model',
                    {},
                    file,
                    () => undefined
                )
            ).toBe(1);
            expect(await readFile(target, 'utf8')).toContain(
                '\r\nHello\r\n\r\n'
            );
        });
    });
    it('cancels an idle decoder without waiting for EOF', async () => {
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        mockAudio.start.mockImplementation(async () => {
            started();
        });
        await output(async (file) => {
            const worker = new RecordingSrtTranscriber();
            const running = worker.run(
                'record.ts',
                'model',
                {},
                file,
                () => undefined
            );
            const rejected = expect(running).rejects.toThrow('cancelled');
            await ready;
            worker.cancel();
            await rejected;
            expect(mockTranslate.stop).toHaveBeenCalled();
        });
    });
    it('stops decoder and lease on inference failure', async () => {
        mockWhisper.transcribe.mockRejectedValueOnce(new Error('failed'));
        await output(async (file) => {
            await expect(
                new RecordingSrtTranscriber().run(
                    'record.ts',
                    'model',
                    {},
                    file,
                    () => undefined
                )
            ).rejects.toThrow('failed');
            expect(mockAudio.stop).toHaveBeenCalled();
            expect(mockWhisper.stop).toHaveBeenCalled();
        });
    });
});
