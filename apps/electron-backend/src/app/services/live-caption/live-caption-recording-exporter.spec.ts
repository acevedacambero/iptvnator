import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiveCaptionRecordingExporter } from './live-caption-recording-exporter';
const mockRun = jest.fn();
const mockCancel = jest.fn();
jest.mock('./recording-srt-transcriber', () => ({
    RecordingSrtTranscriber: jest.fn(() => ({
        run: mockRun,
        cancel: mockCancel,
    })),
}));
jest.mock('./live-caption-translation-settings.store', () => ({
    liveCaptionTranslationSettingsStore: {
        resolveForSession: () => ({ enabled: true, provider: 'google-free' }),
    },
}));
describe('recording SRT lifecycle', () => {
    let dir: string;
    let exporter: LiveCaptionRecordingExporter;
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'iptvnator-export-'));
        exporter = new LiveCaptionRecordingExporter();
        jest.clearAllMocks();
        mockRun.mockImplementation(
            async (_source, _model, _options, output, progress) => {
                await output.writeFile('English\r\n中文');
                progress(50);
                return 0;
            }
        );
    });
    afterEach(async () => {
        exporter.shutdown();
        await rm(dir, { recursive: true, force: true });
    });
    function finished(): Promise<void> {
        return new Promise((resolve) =>
            exporter.subscribe((state) => {
                if (state.state !== 'working') resolve();
            })
        );
    }
    it('captures configuration when recording starts, even if live captions subsequently stop', async () => {
        const source = path.join(dir, 'record.ts');
        exporter.configure('session', 'large-v3', {
            threads: 8,
            translation: {
                enabled: true,
                provider: 'google-free',
                targetLanguage: 'French',
            },
        });
        exporter.begin('session', source);
        exporter.forget('session');
        const done = finished();
        exporter.finish(source);
        await done;
        expect(exporter.snapshot()).toMatchObject({
            state: 'ready',
            filePath: path.join(dir, 'record.srt'),
            progress: 100,
        });
        expect(mockRun.mock.calls[0][1]).toBe('large-v3');
        expect(mockRun.mock.calls[0][2].translation.targetLanguage).toBe(
            'Simplified Chinese'
        );
        expect(await readFile(path.join(dir, 'record.srt'), 'utf8')).toContain(
            '中文'
        );
    });
    it('preserves existing sidecars and serializes recording exports', async () => {
        const source = path.join(dir, 'record.ts'),
            next = path.join(dir, 'next.ts');
        await writeFile(path.join(dir, 'record.srt'), 'existing');
        exporter.configure('session', 'model', {});
        exporter.begin('session', source);
        exporter.begin('session', next);
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
            started = resolve;
        });
        mockRun.mockImplementationOnce(async () => {
            started();
            await blocked;
            return 1;
        });
        let complete!: () => void;
        const all = new Promise<void>((resolve) => {
            complete = resolve;
        });
        exporter.subscribe((state) => {
            if (state.state === 'ready' && state.filePath.endsWith('next.srt'))
                complete();
        });
        exporter.finish(source);
        exporter.finish(next);
        await entered;
        expect(mockRun).toHaveBeenCalledTimes(1);
        release();
        await all;
        expect(await readFile(path.join(dir, 'record.srt'), 'utf8')).toBe(
            'existing'
        );
        expect((await stat(path.join(dir, 'record.ai-1.srt'))).isFile()).toBe(
            true
        );
        expect(mockRun).toHaveBeenCalledTimes(2);
    });
    it('removes only the failed export and preserves the recorded video', async () => {
        const source = path.join(dir, 'record.ts');
        await writeFile(source, 'video');
        mockRun.mockRejectedValueOnce(new Error('decoder failed'));
        exporter.configure('session', 'model', {});
        exporter.begin('session', source);
        const done = finished();
        exporter.finish(source);
        await done;
        // Error state arrives before cleanup; wait until the file handle closes.
        for (let i = 0; i < 100; i++) {
            try {
                await stat(path.join(dir, 'record.srt'));
                await new Promise((resolve) => setTimeout(resolve, 5));
            } catch {
                break;
            }
        }
        expect(exporter.snapshot()?.state).toBe('error');
        await expect(stat(path.join(dir, 'record.srt'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
        expect(await readFile(source, 'utf8')).toBe('video');
    });
    it('ignores unconfigured recordings and isolates notification failures', async () => {
        exporter.finish(path.join(dir, 'unconfigured.ts'));
        expect(mockRun).not.toHaveBeenCalled();
        exporter.subscribe(() => {
            throw new Error('UI failed');
        });
        exporter.configure('session', 'model', {
            translation: { enabled: false },
        });
        exporter.begin('session', path.join(dir, 'record.ts'));
        const done = finished();
        exporter.finish(path.join(dir, 'record.ts'));
        await done;
        expect(exporter.snapshot()?.state).toBe('ready');
        expect(mockRun.mock.calls[0][2].translation).toMatchObject({
            enabled: true,
            provider: 'google-free',
        });
    });
});
