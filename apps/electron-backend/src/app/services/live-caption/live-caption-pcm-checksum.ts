const MODULUS = 65521;
const mod = (value: number) => ((value % MODULUS) + MODULUS) % MODULUS;

/** FFmpeg ashowinfo uses Adler-32 with seed zero on packed PCM bytes. */
export function captionPcmChecksum(pcm: Buffer): number {
    let a = 0;
    let b = 0;
    for (const byte of pcm) {
        a = (a + byte) % MODULUS;
        b = (b + a) % MODULUS;
    }
    return ((b << 16) | a) >>> 0;
}

/** Find a sample-aligned frame within at most one second of decoder preroll. */
export function findCaptionPcmFrame(
    pcm: Buffer,
    bytes: number,
    checksum: number
): number | null {
    if (pcm.length < bytes) return null;
    let sum = captionPcmChecksum(pcm.subarray(0, bytes));
    let a = sum & 0xffff;
    let b = sum >>> 16;
    const limit = Math.min(32000, pcm.length - bytes);
    for (let offset = 0; offset <= limit; offset++) {
        sum = ((b << 16) | a) >>> 0;
        if (offset % 2 === 0 && sum === checksum) return offset;
        if (offset === limit) break;
        a = mod(a - pcm[offset] + pcm[offset + bytes]);
        b = mod(b - bytes * pcm[offset] + a);
    }
    return null;
}
