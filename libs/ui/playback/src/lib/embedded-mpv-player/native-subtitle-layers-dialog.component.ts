import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    signal,
} from '@angular/core';
import {
    MAT_DIALOG_DATA,
    MatDialogModule,
    MatDialogRef,
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
    DEFAULT_NATIVE_SUBTITLE_STYLES,
    validNativeSubtitleLayerStyle,
    type NativeSubtitleLayers,
    type NativeSubtitleLayersState,
    type NativeSubtitleLayerStyle,
} from '@iptvnator/shared/interfaces';
import {
    readNativeSubtitleStyles,
    persistNativeSubtitleStyles,
} from './native-subtitle-layer-preferences';

export interface NativeSubtitleLayersDialogData {
    sessionId: string;
    isCurrent: () => boolean;
}
type Layer = 'upper' | 'lower';

@Component({
    selector: 'app-native-subtitle-layers-dialog',
    templateUrl: './native-subtitle-layers-dialog.component.html',
    styleUrl: './native-subtitle-layers-dialog.component.scss',
    imports: [
        MatDialogModule,
        MatButtonModule,
        MatFormFieldModule,
        MatInputModule,
        MatSelectModule,
        TranslatePipe,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NativeSubtitleLayersDialogComponent {
    private readonly data =
        inject<NativeSubtitleLayersDialogData>(MAT_DIALOG_DATA);
    private readonly ref = inject(
        MatDialogRef<NativeSubtitleLayersDialogComponent>
    );
    private readonly translate = inject(TranslateService);
    readonly state = signal<NativeSubtitleLayersState | null>(null);
    readonly draft = signal<NativeSubtitleLayers | null>(null);
    readonly busy = signal(true);
    readonly error = signal('');
    readonly layerKeys: readonly Layer[] = ['upper', 'lower'];
    readonly validation = computed(() => {
        const value = this.draft();
        if (!value) return '';
        if (
            ![value.upper, value.lower].every((layer) =>
                validNativeSubtitleLayerStyle(layer.style)
            )
        )
            return 'NATIVE_LAYERS_INVALID_STYLE';
        if (value.upper.trackId === null && value.lower.trackId === null)
            return 'NATIVE_LAYERS_CHOOSE_TRACK';
        if (
            value.upper.trackId !== null &&
            value.upper.trackId === value.lower.trackId
        )
            return 'NATIVE_LAYERS_DIFFERENT_TRACKS';
        if (
            value.upper.trackId !== null &&
            value.lower.trackId !== null &&
            value.upper.style.bottomMarginPercent <=
                value.lower.style.bottomMarginPercent
        )
            return 'NATIVE_LAYERS_UPPER_ABOVE_LOWER';
        return '';
    });
    readonly canApply = computed(
        () => !!this.draft() && !this.busy() && !this.validation()
    );

    constructor() {
        void this.load();
    }
    trackLabel(track: NativeSubtitleLayersState['tracks'][number]): string {
        return [
            track.language,
            track.title || `${track.id}`,
            !track.textSupported
                ? this.translate.instant(
                      'EMBEDDED_MPV.PLAYER.NATIVE_LAYERS_BITMAP'
                  )
                : '',
        ]
            .filter(Boolean)
            .join(' · ');
    }
    setTrack(key: Layer, trackId: number | null): void {
        this.draft.update((value) =>
            value ? { ...value, [key]: { ...value[key], trackId } } : value
        );
    }
    setStyle(
        key: Layer,
        field: keyof NativeSubtitleLayerStyle,
        value: string | number
    ): void {
        const converted =
            field === 'fontSize' || field === 'bottomMarginPercent'
                ? Number(value)
                : value;
        this.draft.update((draft) =>
            draft
                ? {
                      ...draft,
                      [key]: {
                          ...draft[key],
                          style: { ...draft[key].style, [field]: converted },
                      },
                  }
                : draft
        );
    }
    inputStyle(
        key: Layer,
        field: keyof NativeSubtitleLayerStyle,
        event: Event
    ): void {
        this.setStyle(key, field, (event.target as HTMLInputElement).value);
    }
    swap(): void {
        const value = this.draft();
        if (value)
            this.draft.set({
                upper: { ...value.upper, trackId: value.lower.trackId },
                lower: { ...value.lower, trackId: value.upper.trackId },
            });
    }
    defaults(): void {
        const value = this.draft();
        if (value)
            this.draft.set({
                upper: {
                    ...value.upper,
                    style: { ...DEFAULT_NATIVE_SUBTITLE_STYLES.upper },
                },
                lower: {
                    ...value.lower,
                    style: { ...DEFAULT_NATIVE_SUBTITLE_STYLES.lower },
                },
            });
    }
    async apply(): Promise<void> {
        const value = this.draft();
        if (!value || !this.canApply()) return;
        await this.save(value);
    }
    async disable(): Promise<void> {
        if (!this.busy()) await this.save(null);
    }
    private async load(): Promise<void> {
        try {
            const api = window.electron?.getEmbeddedMpvSubtitleLayers;
            if (!api || !this.data.isCurrent())
                throw new Error('Playback changed.');
            const state = await api(this.data.sessionId);
            if (!this.data.isCurrent()) throw new Error('Playback changed.');
            this.state.set(state);
            const styles = readNativeSubtitleStyles();
            const tracks = state.tracks.filter((track) => track.textSupported);
            const primary =
                tracks.find(
                    (track) => track.id === state.selectedPrimaryTrackId
                ) ?? tracks[0];
            this.draft.set(
                state.layers ?? {
                    upper: {
                        trackId:
                            tracks.find((track) => track.id !== primary?.id)
                                ?.id ?? null,
                        style: { ...styles.upper },
                    },
                    lower: {
                        trackId: primary?.id ?? null,
                        style: { ...styles.lower },
                    },
                }
            );
            if (state.error)
                this.error.set(
                    this.translate.instant(
                        'EMBEDDED_MPV.PLAYER.NATIVE_LAYERS_FAILED'
                    )
                );
        } catch {
            this.error.set(
                this.translate.instant(
                    'EMBEDDED_MPV.PLAYER.NATIVE_LAYERS_FAILED'
                )
            );
        } finally {
            this.busy.set(false);
        }
    }
    private async save(value: NativeSubtitleLayers | null): Promise<void> {
        try {
            const state = this.state();
            const api = window.electron?.setEmbeddedMpvSubtitleLayers;
            if (!api || !state || !this.data.isCurrent())
                throw new Error('Playback changed.');
            this.busy.set(true);
            this.error.set('');
            await api(this.data.sessionId, value, state.playbackRevision);
            if (!this.data.isCurrent()) throw new Error('Playback changed.');
            if (value) persistNativeSubtitleStyles(value);
            this.ref.close(true);
        } catch {
            this.error.set(
                this.translate.instant(
                    'EMBEDDED_MPV.PLAYER.NATIVE_LAYERS_FAILED'
                )
            );
        } finally {
            this.busy.set(false);
        }
    }
}
