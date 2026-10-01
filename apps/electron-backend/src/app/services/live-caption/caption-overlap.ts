function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function comparisonToken(token: string): string {
    return token
        .toLocaleLowerCase('en-US')
        .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
}

/**
 * Returns the number of words shared by the suffix of `previous` and the
 * prefix of `incoming`. Rolling Whisper windows repeat a small amount of audio;
 * this is the text-side dedupe used before stable segments are translated.
 */
export function findCaptionWordOverlap(
    previous: string,
    incoming: string,
    maxWords = 16
): number {
    const left = normalizeWhitespace(previous).split(' ').filter(Boolean);
    const right = normalizeWhitespace(incoming).split(' ').filter(Boolean);
    const limit = Math.min(maxWords, left.length, right.length);

    for (let size = limit; size > 0; size -= 1) {
        let matches = true;
        for (let offset = 0; offset < size; offset += 1) {
            const leftToken = comparisonToken(left[left.length - size + offset]);
            const rightToken = comparisonToken(right[offset]);
            if (!leftToken || leftToken !== rightToken) {
                matches = false;
                break;
            }
        }
        if (matches) {
            return size;
        }
    }

    return 0;
}

/**
 * Merges an overlapping rolling-ASR hypothesis without repeating the audio
 * shared by adjacent recognition windows. When there is no reliable overlap,
 * the incoming text is appended rather than silently discarded.
 */
export function mergeCaptionOverlap(previous: string, incoming: string): string {
    const left = normalizeWhitespace(previous);
    const right = normalizeWhitespace(incoming);
    if (!left) {
        return right;
    }
    if (!right) {
        return left;
    }

    const overlap = findCaptionWordOverlap(left, right);
    const incomingWords = right.split(' ');
    const novel = incomingWords.slice(overlap).join(' ');
    return novel ? `${left} ${novel}` : left;
}

/** Returns only the new words contributed by an overlapping hypothesis. */
export function extractNovelCaptionText(
    previous: string,
    incoming: string
): string {
    const right = normalizeWhitespace(incoming);
    if (!right) {
        return '';
    }
    const overlap = findCaptionWordOverlap(previous, right);
    return right.split(' ').slice(overlap).join(' ');
}
