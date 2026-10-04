import { open } from 'node:fs/promises';

const PACKET = 188;
const PROBE_BYTES = 512 * 1024;
export const MPEG_TS_PTS_WRAP_SECONDS = 2 ** 33 / 90000;

/** Only audio/video PES PTS; never subtitle payloads or source addresses. */
export function transportStreamPts(bytes: Buffer): number[] {
    const times: number[] = [];
    for (let offset = 0; offset + PACKET <= bytes.length; offset++) {
        if (bytes[offset] !== 0x47 || bytes[offset + 1] & 0x80) continue;
        if (offset + PACKET < bytes.length && bytes[offset + PACKET] !== 0x47)
            continue;
        if (!(bytes[offset + 1] & 0x40)) {
            offset += PACKET - 1;
            continue;
        }
        const control = (bytes[offset + 3] >> 4) & 3;
        if (!(control & 1)) {
            offset += PACKET - 1;
            continue;
        }
        let pes = offset + 4;
        if (control & 2) pes += 1 + bytes[pes];
        const limit = offset + PACKET;
        if (
            pes + 14 <= limit &&
            bytes[pes] === 0 &&
            bytes[pes + 1] === 0 &&
            bytes[pes + 2] === 1
        ) {
            const stream = bytes[pes + 3];
            const flags = bytes[pes + 7] >> 6;
            if (
                stream >= 0xc0 &&
                stream <= 0xef &&
                flags >= 2 &&
                bytes[pes + 8] >= 5
            ) {
                const p = pes + 9;
                if (bytes[p] & 1 && bytes[p + 2] & 1 && bytes[p + 4] & 1) {
                    const pts =
                        ((bytes[p] >> 1) & 7) * 2 ** 30 +
                        bytes[p + 1] * 2 ** 22 +
                        (bytes[p + 2] >> 1) * 2 ** 15 +
                        bytes[p + 3] * 2 ** 7 +
                        (bytes[p + 4] >> 1);
                    times.push(pts / 90000);
                }
            }
        }
        offset += PACKET - 1;
    }
    return times;
}

/** Bounded probes read the saved, remuxed timeline without scanning the whole file. */
export async function readRecordingTsClock(
    filePath: string
): Promise<{ start: number; end: number } | null> {
    const file = await open(filePath, 'r');
    try {
        const size = (await file.stat()).size;
        if (size < PACKET) return null;
        const read = async (position: number) => {
            const bytes = Buffer.alloc(Math.min(PROBE_BYTES, size - position));
            const result = await file.read(bytes, 0, bytes.length, position);
            return transportStreamPts(bytes.subarray(0, result.bytesRead));
        };
        const head = await read(0);
        const tail =
            size > PROBE_BYTES
                ? await read(Math.max(0, size - PROBE_BYTES))
                : head;
        if (!head.length || !tail.length) return null;
        const start = Math.min(...head);
        const unwrapped = tail.map((time) =>
            time < start - MPEG_TS_PTS_WRAP_SECONDS / 2
                ? time + MPEG_TS_PTS_WRAP_SECONDS
                : time
        );
        return { start, end: Math.max(...unwrapped) + 0.05 };
    } finally {
        await file.close();
    }
}
