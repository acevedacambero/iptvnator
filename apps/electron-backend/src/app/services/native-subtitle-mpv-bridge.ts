import type {
    NativeSubtitleLayerTrack,
    NativeSubtitleLayers,
} from '@iptvnator/shared/interfaces';
import { MpvJsonIpcClient } from './live-caption/mpv-json-ipc-client';

export interface NativeSubtitleSelection {
    primary: number | string | boolean;
    secondary: number | string | boolean;
    visible: boolean;
    secondaryVisible: boolean;
}
const BITMAP_CODECS = new Set([
    'dvb_subtitle',
    'dvd_subtitle',
    'hdmv_pgs_subtitle',
    'xsub',
]);
const OVERLAY_ID = 2;

/** Fixed commands only; this object never leaves Electron main. */
export class NativeSubtitleMpvBridge {
    constructor(private readonly client: MpvJsonIpcClient) {}
    async tracks(): Promise<NativeSubtitleLayerTrack[]> {
        const raw = await this.client.command(['get_property', 'track-list']);
        if (!Array.isArray(raw)) return [];
        return raw
            .filter(
                (track) =>
                    track?.type === 'sub' && Number.isSafeInteger(track.id)
            )
            .map((track) => {
                const codec =
                    typeof track.codec === 'string' ? track.codec : '';
                return {
                    id: track.id,
                    title:
                        typeof track.title === 'string'
                            ? track.title.slice(0, 1000)
                            : '',
                    language:
                        typeof track.lang === 'string'
                            ? track.lang.slice(0, 40)
                            : '',
                    codec,
                    textSupported: !!codec && !BITMAP_CODECS.has(codec),
                };
            });
    }
    async selection(): Promise<NativeSubtitleSelection> {
        const values = await Promise.all(
            [
                'sid',
                'secondary-sid',
                'sub-visibility',
                'secondary-sub-visibility',
            ].map((name) => this.client.command(['get_property', name]))
        );
        const track = (value: unknown) =>
            typeof value === 'number' ||
            typeof value === 'string' ||
            typeof value === 'boolean'
                ? value
                : false;
        return {
            primary: track(values[0]),
            secondary: track(values[1]),
            visible: values[2] === true,
            secondaryVisible: values[3] === true,
        };
    }
    async select(layers: NativeSubtitleLayers): Promise<void> {
        await this.client.command(['set_property', 'secondary-sid', 'no']);
        await this.client.command(['set_property', 'sub-visibility', false]);
        await this.client.command([
            'set_property',
            'secondary-sub-visibility',
            false,
        ]);
        await this.client.command([
            'set_property',
            'sid',
            layers.lower.trackId ?? 'no',
        ]);
        await this.client.command([
            'set_property',
            'secondary-sid',
            layers.upper.trackId ?? 'no',
        ]);
    }
    async restore(saved: NativeSubtitleSelection): Promise<void> {
        await this.client.command(['set_property', 'secondary-sid', 'no']);
        await this.client.command(['set_property', 'sid', saved.primary]);
        await this.client.command([
            'set_property',
            'secondary-sid',
            saved.secondary,
        ]);
        await this.client.command([
            'set_property',
            'sub-visibility',
            saved.visible,
        ]);
        await this.client.command([
            'set_property',
            'secondary-sub-visibility',
            saved.secondaryVisible,
        ]);
    }
    async text(): Promise<{ upper: string; lower: string }> {
        const values = await Promise.all(
            ['secondary-sub-text', 'sub-text'].map((name) =>
                this.client.command(['get_property', name]).catch((error) => {
                    if (
                        error instanceof Error &&
                        error.message ===
                            'MPV command failed: property unavailable'
                    )
                        return '';
                    throw error;
                })
            )
        );
        return {
            upper: typeof values[0] === 'string' ? values[0] : '',
            lower: typeof values[1] === 'string' ? values[1] : '',
        };
    }
    async paint(assEvents: string): Promise<void> {
        await this.client.command({
            _name: 'osd-overlay',
            id: OVERLAY_ID,
            format: assEvents ? 'ass-events' : 'none',
            data: assEvents,
            res_x: 1920,
            res_y: 1080,
            z: 55,
        });
    }
}
