import { open, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type {
    LiveCaptionStartOptions,
    LiveCaptionRecordingExport,
} from '@iptvnator/shared/interfaces';
import { RecordingSrtTranscriber } from './recording-srt-transcriber';
import { liveCaptionTranslationSettingsStore } from './live-caption-translation-settings.store';

interface Configuration {
    modelPath: string;
    options: LiveCaptionStartOptions;
}
interface Job extends Configuration {
    sessionId: string;
    source: string;
}

/** Recording hooks capture configuration; export never blocks video finalization. */
export class LiveCaptionRecordingExporter {
    private readonly configurations = new Map<string, Configuration>();
    private readonly recordings = new Map<string, Job>();
    private readonly queue: Job[] = [];
    private readonly listeners = new Set<
        (state: LiveCaptionRecordingExport) => void
    >();
    private worker: RecordingSrtTranscriber | null = null;
    private state: LiveCaptionRecordingExport | undefined;
    private stopped = false;

    configure(
        sessionId: string,
        modelPath: string,
        options: LiveCaptionStartOptions
    ): void {
        const translation =
            options.translation ??
            liveCaptionTranslationSettingsStore.resolveForSession();
        this.configurations.set(sessionId, {
            modelPath,
            options: {
                threads: options.threads,
                translation: translation?.enabled
                    ? { ...translation, targetLanguage: 'Simplified Chinese' }
                    : {
                          enabled: true,
                          provider: 'google-free',
                          targetLanguage: 'Simplified Chinese',
                      },
            },
        });
    }
    forget(sessionId: string): void {
        this.configurations.delete(sessionId);
    }
    begin(sessionId: string, source: string): void {
        const configuration = this.configurations.get(sessionId);
        if (configuration)
            this.recordings.set(source, {
                ...configuration,
                sessionId,
                source,
            });
    }
    finish(source: string): void {
        const job = this.recordings.get(source);
        this.recordings.delete(source);
        if (!job || this.stopped) return;
        if (this.queue.length >= 10) {
            this.publish({
                state: 'error',
                filePath: source,
                progress: 0,
                error: 'Subtitle export queue is full.',
            });
            return;
        }
        this.queue.push(job);
        void this.runNext();
    }
    snapshot(): LiveCaptionRecordingExport | undefined {
        return this.state ? { ...this.state } : undefined;
    }
    subscribe(
        listener: (state: LiveCaptionRecordingExport) => void
    ): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    shutdown(): void {
        this.stopped = true;
        this.queue.length = 0;
        this.worker?.cancel();
        this.configurations.clear();
        this.recordings.clear();
    }

    private async reserve(
        source: string
    ): Promise<{ filePath: string; file: FileHandle }> {
        const base = source.slice(0, -path.extname(source).length);
        for (let suffix = 0; suffix < 100; suffix++) {
            const filePath = `${base}${suffix ? `.ai-${suffix}` : ''}.srt`;
            try {
                return { filePath, file: await open(filePath, 'wx') };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                    throw error;
            }
        }
        throw new Error('No available subtitle filename.');
    }
    private async runNext(): Promise<void> {
        if (this.worker || this.stopped) return;
        const job = this.queue.shift();
        if (!job) return;
        const worker = (this.worker = new RecordingSrtTranscriber());
        let output:
            | Awaited<ReturnType<LiveCaptionRecordingExporter['reserve']>>
            | undefined;
        let success = false;
        this.publish({ state: 'working', filePath: job.source, progress: 0 });
        try {
            output = await this.reserve(job.source);
            const untranslatedCueCount = await worker.run(
                job.source,
                job.modelPath,
                job.options,
                output.file,
                (progress) =>
                    this.publish({
                        state: 'working',
                        filePath: output?.filePath ?? job.source,
                        progress,
                    })
            );
            await output.file.close();
            success = true;
            this.publish({
                state: 'ready',
                filePath: output.filePath,
                progress: 100,
                untranslatedCueCount,
            });
        } catch {
            this.publish({
                state: 'error',
                filePath: job.source,
                progress: 0,
                error: 'Subtitle export failed; the recorded video is unchanged.',
            });
        } finally {
            await output?.file.close().catch(() => undefined);
            // Remove only the sidecar this job exclusively created, never an existing file.
            if (!success && output)
                await unlink(output.filePath).catch(() => undefined);
            this.worker = null;
            void this.runNext();
        }
    }
    private publish(state: LiveCaptionRecordingExport): void {
        this.state = state;
        for (const listener of this.listeners) {
            try {
                listener({ ...state });
            } catch {
                /* UI listeners cannot fail a recording export. */
            }
        }
    }
}
export const liveCaptionRecordingExporter = new LiveCaptionRecordingExporter();
