import { LiveCaptionCcLineBuffer } from './live-caption-cc-line';

describe('LiveCaptionCcLineBuffer', () => {
    it('waits for a stable line before emitting', () => {
        const buffer = new LiveCaptionCcLineBuffer(6, 3);
        expect(buffer.push('The Federal Reserve')).toBeNull();
        expect(buffer.push('kept rates unchanged.')).toBe(
            'The Federal Reserve kept rates unchanged.'
        );
        expect(buffer.pendingText).toBe('');
    });

    it('emits by word limit without rewriting an existing line', () => {
        const buffer = new LiveCaptionCcLineBuffer(5, 3);
        expect(buffer.push('one two three four five six seven')).toBe(
            'one two three four five'
        );
        expect(buffer.pendingText).toBe('six seven');
        expect(buffer.push('eight nine ten')).toBe(
            'six seven eight nine ten'
        );
    });

    it('flushes a short final line when speech stops', () => {
        const buffer = new LiveCaptionCcLineBuffer(8, 3);
        expect(buffer.push('Thank you everyone')).toBeNull();
        expect(buffer.flush()).toBe('Thank you everyone');
        expect(buffer.pendingText).toBe('');
    });

    it('clears pending text', () => {
        const buffer = new LiveCaptionCcLineBuffer();
        buffer.push('pending words');
        buffer.clear();
        expect(buffer.pendingText).toBe('');
        expect(buffer.flush()).toBeNull();
    });
});
