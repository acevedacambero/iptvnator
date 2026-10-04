import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordingSrtBlock, srtTimestamp } from './recording-srt';
import {
    readRecordingTsClock,
    transportStreamPts,
    MPEG_TS_PTS_WRAP_SECONDS,
} from './recording-ts-clock';

function packet(seconds: number, stream = 0xe0, adaptation = false): Buffer {
    const data = Buffer.alloc(188, 0xff);
    data[0] = 0x47;
    data[1] = 0x40;
    data[2] = 1;
    data[3] = adaptation ? 0x30 : 0x10;
    if (adaptation) data[4] = 6;
    const pes = adaptation ? 11 : 4;
    data.set([0, 0, 1, stream, 0, 0, 0x80, 0x80, 5], pes);
    const pts = BigInt(Math.round(seconds * 90000));
    data[pes + 9] = 0x21 | Number((pts >> 29n) & 14n);
    data[pes + 10] = Number((pts >> 22n) & 255n);
    data[pes + 11] = 1 | Number((pts >> 14n) & 254n);
    data[pes + 12] = Number((pts >> 7n) & 255n);
    data[pes + 13] = 1 | Number((pts << 1n) & 254n);
    return data;
}
describe('recorded SRT timeline', () => {
    it('rounds milliseconds across minute and hour boundaries', () => {
        expect(srtTimestamp(59.9996)).toBe('00:01:00,000');
        expect(srtTimestamp(3600.001)).toBe('01:00:00,001');
    });
    it('rebases and clips bilingual cues, retaining UTF-8 text', () => {
        expect(
            recordingSrtBlock(
                { start: 9, end: 12, source: 'Hello', translated: '你好' },
                1,
                10,
                1.5
            )
        ).toBe('1\r\n00:00:00,000 --> 00:00:01,500\r\nHello\r\n你好\r\n\r\n');
        expect(
            recordingSrtBlock(
                { start: 13, end: 14, source: 'outside' },
                2,
                10,
                1.5
            )
        ).toBe('');
        expect(
            recordingSrtBlock({ start: NaN, end: 14, source: 'bad' }, 2, 10, 5)
        ).toBe('');
    });
    it('prevents text from injecting cues or formatting', () => {
        const block = recordingSrtBlock(
            { start: 0, end: 1, source: '<b>A&B</b>\n\n2\0' },
            1,
            0,
            2
        );
        expect(block).toContain('&lt;b&gt;A&amp;B&lt;/b&gt; 2');
        expect(block.match(/\r\n\r\n/g)).toHaveLength(1);
    });
    it('reads only valid audio/video PES PTS and resynchronizes tail probes', () => {
        const broken = packet(99);
        broken[17] &= 0xfe;
        const bytes = Buffer.concat([
            Buffer.alloc(7),
            packet(1.25),
            packet(2.5, 0xc0, true),
            packet(3, 0xbd),
            broken,
            packet(5).subarray(0, 50),
        ]);
        expect(transportStreamPts(bytes)).toEqual([1.25, 2.5]);
    });
    it('probes the saved file and unwraps a long recording clock', async () => {
        const dir = await mkdtemp(
            path.join(os.tmpdir(), 'iptvnator-ts-clock-')
        );
        try {
            const file = path.join(dir, 'record.ts');
            await writeFile(
                file,
                Buffer.concat([packet(0), packet(3.2, 0xc0)])
            );
            expect(await readRecordingTsClock(file)).toEqual({
                start: 0,
                end: 3.25,
            });
            const middle = Buffer.alloc(188 * 6000);
            for (let i = 0; i < middle.length; i += 188) {
                middle[i] = 0x47;
                middle[i + 3] = 0;
            }
            await writeFile(
                file,
                Buffer.concat([
                    packet(MPEG_TS_PTS_WRAP_SECONDS - 2),
                    middle,
                    packet(1),
                ])
            );
            expect((await readRecordingTsClock(file))?.end).toBeCloseTo(
                MPEG_TS_PTS_WRAP_SECONDS + 1.05
            );
            await writeFile(file, Buffer.alloc(25));
            expect(await readRecordingTsClock(file)).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
