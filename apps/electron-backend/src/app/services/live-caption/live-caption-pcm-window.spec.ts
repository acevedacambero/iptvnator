import { LiveCaptionPcmWindow } from './live-caption-pcm-window';

describe('LiveCaptionPcmWindow', () => {
    it('emits after one step of new audio', () => {
        const window = new LiveCaptionPcmWindow({
            sampleRate: 10,
            channels: 1,
            bytesPerSample: 2,
            windowSeconds: 2,
            stepSeconds: 0.5,
        });
        expect(window.stepBytes).toBe(10);
        expect(window.push(Buffer.alloc(9))).toBeNull();
        expect(window.push(Buffer.alloc(1, 7))).toHaveLength(10);
    });

    it('keeps only the newest configured window', () => {
        const window = new LiveCaptionPcmWindow({
            sampleRate: 10,
            channels: 1,
            bytesPerSample: 1,
            windowSeconds: 2,
            stepSeconds: 1,
        });
        window.push(Buffer.from([...Array(10).keys()]));
        const snapshot = window.push(
            Buffer.from([...Array(20).keys()].map((value) => value + 10))
        );
        expect(snapshot).not.toBeNull();
        expect(snapshot?.length).toBe(20);
        expect(snapshot?.[0]).toBe(10);
        expect(snapshot?.[19]).toBe(29);
    });

    it('does not queue old snapshots when the consumer is busy', () => {
        const window = new LiveCaptionPcmWindow({
            sampleRate: 10,
            channels: 1,
            bytesPerSample: 1,
            windowSeconds: 2,
            stepSeconds: 0.5,
        });
        expect(window.push(Buffer.alloc(15, 1))).toHaveLength(15);
        expect(window.push(Buffer.alloc(15, 2))).toHaveLength(20);
        expect(window.snapshot()).toEqual(Buffer.concat([
            Buffer.alloc(5, 1),
            Buffer.alloc(15, 2),
        ]));
    });

    it('clears history and timing state on channel changes', () => {
        const window = new LiveCaptionPcmWindow({
            sampleRate: 10,
            channels: 1,
            bytesPerSample: 1,
            windowSeconds: 2,
            stepSeconds: 1,
        });
        window.push(Buffer.alloc(10));
        expect(window.receivedSeconds).toBe(1);
        window.clear();
        expect(window.snapshot()).toHaveLength(0);
        expect(window.receivedSeconds).toBe(0);
        expect(window.push(Buffer.alloc(9))).toBeNull();
    });

    it('rejects invalid timing parameters', () => {
        expect(
            () =>
                new LiveCaptionPcmWindow({
                    windowSeconds: 1,
                    stepSeconds: 2,
                })
        ).toThrow('stepSeconds must not exceed windowSeconds');
    });
});
