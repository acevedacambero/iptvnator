import { LiveCaptionLifecycle } from './live-caption-lifecycle';

describe('LiveCaptionLifecycle', () => {
    function create() {
        const pipeline = {
            getSupport: jest.fn(),
            getState: jest.fn(() => ({
                state: 'inactive' as const,
                active: false,
                generation: 1,
            })),
            subscribe: jest.fn(),
            start: jest.fn().mockResolvedValue({}),
            stop: jest.fn().mockResolvedValue({}),
            shutdown: jest.fn(),
            setUserPaused: jest.fn(),
        };
        return { pipeline, lifecycle: new LiveCaptionLifecycle(pipeline) };
    }
    it('suspends capture on pause and resumes the chosen caption configuration', async () => {
        const { pipeline, lifecycle } = create();
        const options = { threads: 4, translation: { enabled: true } };
        await lifecycle.start('session', options);
        await lifecycle.setPaused('session', true);
        expect(lifecycle.getState()).toMatchObject({
            active: true,
            state: 'suspended',
        });
        expect(pipeline.stop).toHaveBeenCalledWith('session');
        expect(pipeline.setUserPaused).toHaveBeenCalledWith(true);
        expect(pipeline.setUserPaused.mock.invocationCallOrder[0]).toBeLessThan(
            pipeline.stop.mock.invocationCallOrder[0]
        );
        await lifecycle.setPaused('session', false);
        expect(pipeline.start).toHaveBeenLastCalledWith('session', options);
    });
    it('does not resume after captions were disabled during pause', async () => {
        const { pipeline, lifecycle } = create();
        await lifecycle.start('session');
        await lifecycle.setPaused('session', true);
        await lifecycle.stop('session');
        await lifecycle.setPaused('session', false);
        expect(pipeline.start).toHaveBeenCalledTimes(1);
        expect(lifecycle.getState().active).toBe(false);
    });
    it('clears capture before seeking and restarts after the command', async () => {
        const { pipeline, lifecycle } = create();
        await lifecycle.start('session');
        const action = jest.fn(() => 42);
        expect(await lifecycle.withPlaybackChange('session', action)).toBe(42);
        expect(pipeline.stop.mock.invocationCallOrder[0]).toBeLessThan(
            action.mock.invocationCallOrder[0]
        );
        expect(pipeline.start.mock.invocationCallOrder[1]).toBeGreaterThan(
            action.mock.invocationCallOrder[0]
        );
    });
    it('does not resurrect captions after a pending channel change was superseded by Stop', async () => {
        const { pipeline, lifecycle } = create();
        await lifecycle.start('session');
        let complete!: () => void;
        const change = lifecycle.withPlaybackChange(
            'session',
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve;
                })
        );
        await Promise.resolve();
        await lifecycle.stop('session');
        complete();
        await change;
        expect(pipeline.start).toHaveBeenCalledTimes(1);
    });
    it('changes playback normally when captions were not enabled', async () => {
        const { pipeline, lifecycle } = create();
        await lifecycle.withPlaybackChange('session', () => undefined);
        expect(pipeline.stop).not.toHaveBeenCalled();
        expect(pipeline.start).not.toHaveBeenCalled();
    });
});
