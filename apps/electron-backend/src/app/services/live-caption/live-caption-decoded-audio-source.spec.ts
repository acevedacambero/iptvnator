import { CaptionAudioFrameReader } from './live-caption-decoded-audio-source';
import { captionPcmChecksum } from './live-caption-pcm-checksum';

jest.mock('electron', () => ({
    app: { isPackaged: false, getAppPath: () => '' },
}));
describe('decoded audio frame protocol', () => {
    it('joins metadata and PCM even when either pipe delivers first and PCM splits samples', () => {
        const reader = new CaptionAudioFrameReader();
        expect(
            reader.pushStamp({
                pts: 4200,
                samples: 3,
                checksum: captionPcmChecksum(Buffer.from([1, 0, 2, 0, 3, 0])),
            })
        ).toEqual([]);
        expect(reader.pushPcm(Buffer.from([1, 0, 2]))).toEqual([]);
        expect(reader.pushPcm(Buffer.from([0, 3, 0]))).toEqual([
            {
                pcm: Buffer.from([1, 0, 2, 0, 3, 0]),
                pts: 4200,
                end: 4200 + 3 / 16000,
            },
        ]);
        reader.pushPcm(Buffer.alloc(4, 7));
        expect(
            reader.pushStamp({
                pts: 4201,
                samples: 2,
                checksum: captionPcmChecksum(Buffer.alloc(4, 7)),
            })[0].pcm
        ).toEqual(Buffer.alloc(4, 7));
    });
    it('discards unlabelled seek preroll instead of pairing later timestamps with earlier audio', () => {
        const reader = new CaptionAudioFrameReader();
        const pcm = Buffer.from([19, 0, 20, 0, 21, 0]);
        reader.pushPcm(Buffer.concat([Buffer.alloc(9600, 55), pcm]));
        expect(
            reader.pushStamp({
                pts: 20,
                samples: 3,
                checksum: captionPcmChecksum(pcm),
            })
        ).toEqual([{ pcm, pts: 20, end: 20 + 3 / 16000 }]);
        expect(reader.empty).toBe(true);
    });
    it('rejects unmatched audio at EOF or after the bounded resynchronization window', () => {
        const reader = new CaptionAudioFrameReader();
        reader.pushStamp({
            pts: 20,
            samples: 3,
            checksum: captionPcmChecksum(Buffer.alloc(6, 9)),
        });
        reader.pushPcm(Buffer.alloc(6));
        expect(() => reader.finish()).toThrow('matching media timestamps');
        expect(() => reader.pushPcm(Buffer.alloc(32000))).toThrow(
            'does not match'
        );
    });
    it('rejects malformed timestamps and limits memory on a missing clock pipe', () => {
        const reader = new CaptionAudioFrameReader();
        expect(() => reader.pushStamp({ pts: NaN, samples: 1600 })).toThrow(
            'timestamp'
        );
        expect(() => reader.pushStamp({ pts: 1, samples: -1 })).toThrow(
            'timestamp'
        );
        expect(() => reader.pushPcm(Buffer.alloc(2_000_001))).toThrow(
            'bounded buffer'
        );
    });
});
