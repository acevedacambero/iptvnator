import { SharedWhisperLease } from './live-caption-whisper-pool';
const mockClients: {
    start: jest.Mock;
    transcribe: jest.Mock;
    stop: jest.Mock;
}[] = [];
jest.mock('./live-caption-whisper-client', () => ({
    LiveCaptionWhisperClient: jest.fn(() => {
        const client = {
            start: jest.fn().mockResolvedValue({}),
            transcribe: jest.fn().mockResolvedValue({ text: 'text' }),
            stop: jest.fn(),
        };
        mockClients.push(client);
        return client;
    }),
}));
describe('shared Whisper GPU allocation', () => {
    const leases: SharedWhisperLease[] = [];
    const lease = (priority = 0) => {
        const value = new SharedWhisperLease(priority);
        leases.push(value);
        return value;
    };
    afterEach(() => {
        leases.splice(0).forEach((value) => value.stop());
        mockClients.length = 0;
    });
    it('shares one model and gives realtime work priority over queued exports', async () => {
        const background = lease(1),
            realtime = lease();
        await background.start({ modelPath: 'model' });
        await realtime.start({ modelPath: 'model' });
        expect(mockClients).toHaveLength(1);
        let resolve!: (result: { text: string }) => void;
        mockClients[0].transcribe.mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = done;
                })
        );
        const first = background.transcribe(Buffer.from('first'));
        await Promise.resolve();
        await Promise.resolve();
        const exportNext = background.transcribe(Buffer.from('export'));
        const live = realtime.transcribe(Buffer.from('live'));
        resolve({ text: 'first' });
        await Promise.all([first, exportNext, live]);
        expect(
            mockClients[0].transcribe.mock.calls.map((call) =>
                call[0].toString()
            )
        ).toEqual(['first', 'live', 'export']);
        background.stop();
        expect(mockClients[0].stop).not.toHaveBeenCalled();
        realtime.stop();
        expect(mockClients[0].stop).toHaveBeenCalledTimes(1);
    });
    it('cancels queued work without stopping another active lease', async () => {
        const background = lease(1),
            realtime = lease();
        await background.start({ modelPath: 'model' });
        await realtime.start({ modelPath: 'model' });
        const cancelled = background.transcribe(Buffer.from('export'));
        const assertion = expect(cancelled).rejects.toThrow('cancelled');
        background.stop();
        await assertion;
        expect(mockClients[0].stop).not.toHaveBeenCalled();
        await expect(realtime.transcribe(Buffer.from('live'))).resolves.toEqual(
            { text: 'text' }
        );
    });
    it('isolates different model allocations and propagates inference failure', async () => {
        const a = lease(),
            b = lease(1);
        await a.start({ modelPath: 'a' });
        await b.start({ modelPath: 'b' });
        expect(mockClients).toHaveLength(2);
        mockClients[0].transcribe.mockRejectedValueOnce(
            new Error('inference failed')
        );
        await expect(a.transcribe(Buffer.alloc(1))).rejects.toThrow(
            'inference failed'
        );
        await expect(b.transcribe(Buffer.alloc(1))).resolves.toEqual({
            text: 'text',
        });
    });
});
