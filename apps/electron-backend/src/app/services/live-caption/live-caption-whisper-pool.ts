import {
    LiveCaptionWhisperClient,
    type LiveCaptionWhisperResult,
} from './live-caption-whisper-client';

type Options = Parameters<LiveCaptionWhisperClient['start']>[0];
interface Work {
    lease: SharedWhisperLease;
    pcm: Buffer;
    resolve: (result: LiveCaptionWhisperResult) => void;
    reject: (error: unknown) => void;
}
interface Worker {
    client: LiveCaptionWhisperClient;
    ready: ReturnType<LiveCaptionWhisperClient['start']>;
    users: Set<SharedWhisperLease>;
    queue: Work[];
    busy: boolean;
}
const workers = new Map<string, Worker>();

/** One model allocation; realtime requests precede background SRT jobs. */
export class SharedWhisperLease {
    private worker: Worker | null = null;
    private key = '';
    constructor(readonly priority = 0) {}

    async start(options: Options = {}): Promise<Awaited<Worker['ready']>> {
        this.stop();
        this.key = options?.modelPath ?? 'default';
        let worker = workers.get(this.key);
        if (!worker) {
            const client = new LiveCaptionWhisperClient();
            worker = {
                client,
                ready: client.start(options),
                users: new Set(),
                queue: [],
                busy: false,
            };
            workers.set(this.key, worker);
        }
        this.worker = worker;
        worker.users.add(this);
        return worker.ready;
    }

    transcribe(pcm: Buffer): Promise<LiveCaptionWhisperResult> {
        const worker = this.worker;
        if (!worker)
            return Promise.reject(new Error('Whisper lease is stopped.'));
        if (worker.queue.length >= 8)
            return Promise.reject(
                new Error('Whisper inference queue is full.')
            );
        return new Promise((resolve, reject) => {
            worker.queue.push({ lease: this, pcm, resolve, reject });
            worker.queue.sort((a, b) => a.lease.priority - b.lease.priority);
            void this.pump(worker);
        });
    }

    stop(): void {
        const worker = this.worker;
        if (!worker) return;
        this.worker = null;
        worker.users.delete(this);
        for (const work of worker.queue.filter((work) => work.lease === this))
            work.reject(new Error('Whisper request cancelled.'));
        worker.queue = worker.queue.filter((work) => work.lease !== this);
        if (!worker.users.size) {
            if (workers.get(this.key) === worker) workers.delete(this.key);
            worker.client.stop();
        }
    }

    private async pump(worker: Worker): Promise<void> {
        if (worker.busy) return;
        worker.busy = true;
        try {
            await worker.ready;
            while (worker.queue.length && worker.users.size) {
                const work = worker.queue.shift();
                if (!work) break;
                try {
                    const result = await worker.client.transcribe(work.pcm);
                    if (worker.users.has(work.lease)) work.resolve(result);
                    else work.reject(new Error('Whisper request cancelled.'));
                } catch (error) {
                    work.reject(error);
                }
            }
        } catch (error) {
            for (const work of worker.queue.splice(0)) work.reject(error);
        } finally {
            worker.busy = false;
        }
    }
}
