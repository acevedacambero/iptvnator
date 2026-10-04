import {
    validNativeSubtitleLayerStyle,
    type NativeSubtitleLayers,
    type NativeSubtitleLayersState,
} from '@iptvnator/shared/interfaces';
import { liveCaptionMpvOverlayService } from './live-caption/live-caption-mpv-overlay.service';
import { buildNativeSubtitleLayerAss } from './native-subtitle-layers-ass';
import type {
    NativeSubtitleMpvBridge,
    NativeSubtitleSelection,
} from './native-subtitle-mpv-bridge';

interface Runtime {
    bridge: NativeSubtitleMpvBridge;
    layers: NativeSubtitleLayers;
    saved: NativeSubtitleSelection;
    timer?: NodeJS.Timeout;
    pending?: Promise<void>;
    cancelled: boolean;
    lastAss: string | null;
}

/** File-scoped native subtitle ownership, separate from AI overlay id 1. */
export class NativeSubtitleLayersService {
    private readonly vod = new Set<string>();
    private readonly runtimes = new Map<string, Runtime>();
    private readonly operations = new Map<string, Promise<unknown>>();
    private readonly errors = new Map<string, string>();
    private readonly revisions = new Map<string, number>();
    constructor(
        private readonly bridgeFor = (id: string) =>
            liveCaptionMpvOverlayService.nativeSubtitleBridge(id)
    ) {}

    setPlaybackKind(id: string, vod: boolean): void {
        if (vod) this.vod.add(id);
        else this.vod.delete(id);
        this.errors.delete(id);
        this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    }
    withPlaybackChange<T>(
        id: string,
        vod: boolean,
        action: () => Promise<T>
    ): Promise<T> {
        return this.serial(id, async () => {
            await this.stopRuntime(id);
            this.setPlaybackKind(id, vod);
            return action();
        });
    }
    async get(id: string): Promise<NativeSubtitleLayersState> {
        if (!this.vod.has(id))
            throw new Error(
                'Layered subtitles require a movie or episode in the native player.'
            );
        const bridge = this.bridgeFor(id);
        const playbackRevision = this.revisions.get(id) ?? 0;
        const [tracks, selection] = await Promise.all([
            bridge.tracks(),
            bridge.selection(),
        ]);
        if (playbackRevision !== this.revisions.get(id))
            throw new Error('Playback changed; reopen subtitle settings.');
        return {
            playbackRevision,
            tracks,
            selectedPrimaryTrackId:
                typeof selection.primary === 'number'
                    ? selection.primary
                    : null,
            layers: this.runtimes.has(id)
                ? structuredClone(this.runtimes.get(id)?.layers)
                : null,
            ...(this.errors.has(id) ? { error: this.errors.get(id) } : {}),
        };
    }
    set(
        id: string,
        value: NativeSubtitleLayers | null,
        playbackRevision: number
    ): Promise<NativeSubtitleLayersState> {
        return this.serial(id, async () => {
            const state = await this.get(id);
            if (playbackRevision !== state.playbackRevision)
                throw new Error('Playback changed; reopen subtitle settings.');
            if (value !== null) this.validate(value, state);
            await this.stopRuntime(id);
            this.errors.delete(id);
            if (value !== null) {
                const bridge = this.bridgeFor(id);
                const runtime: Runtime = {
                    bridge,
                    layers: structuredClone(value),
                    saved: await bridge.selection(),
                    cancelled: false,
                    lastAss: null,
                };
                this.runtimes.set(id, runtime);
                try {
                    await bridge.select(runtime.layers);
                    await this.tick(id, runtime);
                    if (runtime.cancelled)
                        throw new Error(
                            'Unable to display the selected subtitle layers.'
                        );
                    runtime.timer = setInterval(() => {
                        if (!runtime.pending && !runtime.cancelled)
                            runtime.pending = this.tick(id, runtime).finally(
                                () => {
                                    runtime.pending = undefined;
                                }
                            );
                    }, 60);
                    runtime.timer.unref();
                } catch (error) {
                    await this.stopRuntime(id);
                    throw error;
                }
            }
            return this.get(id);
        });
    }
    stop(id: string): Promise<void> {
        return this.serial(id, () => this.stopRuntime(id));
    }
    async forget(id: string): Promise<void> {
        await this.stop(id);
        this.vod.delete(id);
        this.errors.delete(id);
        this.revisions.delete(id);
    }
    shutdown(): void {
        this.vod.clear();
        this.revisions.clear();
        for (const runtime of this.runtimes.values()) {
            runtime.cancelled = true;
            clearInterval(runtime.timer);
        }
        this.runtimes.clear();
    }
    private validate(
        value: NativeSubtitleLayers,
        state: NativeSubtitleLayersState
    ): void {
        if (!value || !value.upper || !value.lower)
            throw new Error('Invalid subtitle layer settings.');
        for (const layer of [value.upper, value.lower]) {
            if (!validNativeSubtitleLayerStyle(layer.style))
                throw new Error('Invalid subtitle size, position or color.');
            if (
                layer.trackId !== null &&
                (!Number.isSafeInteger(layer.trackId) ||
                    !state.tracks.some(
                        (track) =>
                            track.id === layer.trackId && track.textSupported
                    ))
            )
                throw new Error(
                    'Choose a text subtitle track; picture subtitles do not have editable fonts.'
                );
        }
        if (value.upper.trackId === null && value.lower.trackId === null)
            throw new Error('Choose at least one subtitle track.');
        if (
            value.upper.trackId !== null &&
            value.upper.trackId === value.lower.trackId
        )
            throw new Error('Choose two different subtitle tracks.');
        if (
            value.upper.trackId !== null &&
            value.lower.trackId !== null &&
            value.upper.style.bottomMarginPercent <=
                value.lower.style.bottomMarginPercent
        )
            throw new Error('Position the upper layer above the lower layer.');
    }
    private async tick(id: string, runtime: Runtime): Promise<void> {
        try {
            const text = await runtime.bridge.text();
            if (runtime.cancelled || this.runtimes.get(id) !== runtime) return;
            const ass = buildNativeSubtitleLayerAss(
                runtime.layers,
                text.upper,
                text.lower
            );
            if (ass !== runtime.lastAss) {
                await runtime.bridge.paint(ass);
                runtime.lastAss = ass;
            }
        } catch {
            runtime.cancelled = true;
            clearInterval(runtime.timer);
            this.runtimes.delete(id);
            this.errors.set(
                id,
                'Layered subtitles stopped; select a subtitle track to continue.'
            );
            await runtime.bridge.paint('').catch(() => undefined);
            await runtime.bridge.restore(runtime.saved).catch(() => undefined);
        }
    }
    private async stopRuntime(id: string): Promise<void> {
        const runtime = this.runtimes.get(id);
        if (!runtime) return;
        runtime.cancelled = true;
        clearInterval(runtime.timer);
        this.runtimes.delete(id);
        await runtime.pending;
        await runtime.bridge.paint('').catch(() => undefined);
        await runtime.bridge.restore(runtime.saved);
    }
    private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
        const operation = (this.operations.get(id) ?? Promise.resolve())
            .catch(() => undefined)
            .then(action);
        this.operations.set(id, operation);
        void operation
            .finally(() => {
                if (this.operations.get(id) === operation)
                    this.operations.delete(id);
            })
            .catch(() => undefined);
        return operation;
    }
}
export const nativeSubtitleLayersService = new NativeSubtitleLayersService();
