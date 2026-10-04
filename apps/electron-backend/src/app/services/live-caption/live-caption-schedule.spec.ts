import { LiveCaptionSchedule } from './live-caption-schedule';

describe('synchronized caption schedule', () => {
    it('buffers until both languages are ready ahead of media time', () => {
        const schedule = new LiveCaptionSchedule();
        const cue = {
            start: 101,
            end: 103,
            source: 'Hello',
            translated: '你好',
        };
        schedule.add([cue], 109);
        expect(schedule.at(100)).toMatchObject({ cue: null, hold: true });
        schedule.add([], 112);
        expect(schedule.at(100).hold).toBe(false);
        expect(schedule.at(101).cue).toBe(cue);
        expect(schedule.at(101).cue).toBe(cue); // A stalled video keeps its subtitle.
        expect(schedule.at(103).cue).toBeNull();
    });
    it('holds playback when recognition falls behind and resumes with a new buffer', () => {
        const schedule = new LiveCaptionSchedule();
        schedule.add([], 20);
        expect(schedule.at(0).hold).toBe(false);
        expect(schedule.at(19.5).hold).toBe(true);
        schedule.add([], 25);
        expect(schedule.at(19.5).hold).toBe(true);
        schedule.add([], 30);
        expect(schedule.at(19.5).hold).toBe(false);
    });
    it('expires old cues without replaying them after a seek', () => {
        const schedule = new LiveCaptionSchedule();
        schedule.add(
            [
                { start: 0, end: 2, source: 'Old' },
                { start: 7, end: 9, source: 'New' },
            ],
            30
        );
        expect(schedule.at(7).cue?.source).toBe('New');
        expect(schedule.at(20).cue).toBeNull();
        expect(schedule.at(0).cue).toBeNull();
    });
    it('plays the final short buffer at end of file', () => {
        const schedule = new LiveCaptionSchedule();
        schedule.add([], 4);
        schedule.ended = true;
        expect(schedule.at(0).hold).toBe(false);
        expect(schedule.at(4).hold).toBe(false);
    });
});
