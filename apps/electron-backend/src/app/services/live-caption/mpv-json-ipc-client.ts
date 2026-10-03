import { Socket, createConnection } from 'node:net';

interface MpvIpcReply {
    request_id?: number;
    error?: string;
    data?: unknown;
    event?: string;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

const CONNECT_RETRY_DELAY_MS = 50;
const CONNECT_RETRY_COUNT = 40;
const REQUEST_TIMEOUT_MS = 2000;

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Persistent client for mpv's Windows `input-ipc-server` named pipe.
 *
 * The connection intentionally stays open while AI captions are enabled:
 * mpv associates `osd-overlay` ownership with the IPC client and removes the
 * overlay as soon as that client disconnects.
 */
export class MpvJsonIpcClient {
    private socket: Socket | null = null;
    private connecting: Promise<void> | null = null;
    private buffer = '';
    private nextRequestId = 1;
    private readonly pending = new Map<number, PendingRequest>();

    constructor(private readonly pipePath: string) {}

    async command(command: Record<string, unknown>): Promise<unknown> {
        await this.ensureConnected();
        const socket = this.socket;
        if (!socket || socket.destroyed) {
            throw new Error('MPV JSON IPC pipe is not connected.');
        }

        const requestId = this.nextRequestId++;
        const message = `${JSON.stringify({
            command,
            request_id: requestId,
        })}\n`;

        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error('MPV JSON IPC command timed out.'));
            }, REQUEST_TIMEOUT_MS);

            this.pending.set(requestId, { resolve, reject, timer });
            socket.write(message, 'utf8', (error) => {
                if (!error) {
                    return;
                }
                const pending = this.pending.get(requestId);
                if (!pending) {
                    return;
                }
                clearTimeout(pending.timer);
                this.pending.delete(requestId);
                pending.reject(error);
            });
        });
    }

    close(): void {
        const socket = this.socket;
        this.socket = null;
        this.connecting = null;
        this.buffer = '';
        this.rejectPending(new Error('MPV JSON IPC connection closed.'));
        socket?.destroy();
    }

    private async ensureConnected(): Promise<void> {
        if (this.socket && !this.socket.destroyed) {
            return;
        }
        if (this.connecting) {
            return this.connecting;
        }
        this.connecting = this.connectWithRetry().finally(() => {
            this.connecting = null;
        });
        return this.connecting;
    }

    private async connectWithRetry(): Promise<void> {
        let lastError: unknown;
        for (let attempt = 0; attempt < CONNECT_RETRY_COUNT; attempt += 1) {
            try {
                await this.connectOnce();
                return;
            } catch (error) {
                lastError = error;
                if (attempt + 1 < CONNECT_RETRY_COUNT) {
                    await delay(CONNECT_RETRY_DELAY_MS);
                }
            }
        }
        throw new Error(
            `Unable to connect to MPV IPC pipe ${this.pipePath}: ${
                lastError instanceof Error ? lastError.message : String(lastError)
            }`
        );
    }

    private connectOnce(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const socket = createConnection(this.pipePath);
            let settled = false;

            const fail = (error: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                reject(error);
            };

            socket.once('error', fail);
            socket.once('connect', () => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.off('error', fail);
                this.attachSocket(socket);
                resolve();
            });
        });
    }

    private attachSocket(socket: Socket): void {
        this.socket?.destroy();
        this.socket = socket;
        this.buffer = '';
        socket.on('data', (chunk: Buffer | string) =>
            this.onData(chunk.toString('utf8'))
        );
        socket.on('error', (error) => this.onSocketClosed(error));
        socket.on('close', () =>
            this.onSocketClosed(new Error('MPV JSON IPC pipe closed.'))
        );
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        while (true) {
            const newline = this.buffer.indexOf('\n');
            if (newline < 0) {
                return;
            }
            const raw = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!raw) {
                continue;
            }
            let message: MpvIpcReply;
            try {
                message = JSON.parse(raw) as MpvIpcReply;
            } catch {
                continue;
            }
            if (message.event || typeof message.request_id !== 'number') {
                continue;
            }
            const pending = this.pending.get(message.request_id);
            if (!pending) {
                continue;
            }
            clearTimeout(pending.timer);
            this.pending.delete(message.request_id);
            if (message.error && message.error !== 'success') {
                pending.reject(new Error(`MPV command failed: ${message.error}`));
            } else {
                pending.resolve(message.data);
            }
        }
    }

    private onSocketClosed(error: Error): void {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.buffer = '';
        this.rejectPending(error);
    }

    private rejectPending(error: Error): void {
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
    }
}
