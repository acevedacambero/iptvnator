import {
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    inject,
    OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSliderModule } from '@angular/material/slider';
import { TranslateModule } from '@ngx-translate/core';
import {
    DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS,
    type LiveCaptionDisplaySettings,
} from '@iptvnator/shared/interfaces';

interface DisplayApi {
    getDisplaySettings(): Promise<LiveCaptionDisplaySettings>;
    updateDisplaySettings(
        settings: LiveCaptionDisplaySettings
    ): Promise<LiveCaptionDisplaySettings>;
    getSupport(): Promise<{ supported: boolean }>;
}

@Component({
    selector: 'app-settings-live-caption-display',
    imports: [
        FormsModule,
        MatButtonModule,
        MatFormFieldModule,
        MatInputModule,
        MatSelectModule,
        MatSliderModule,
        TranslateModule,
    ],
    templateUrl: './settings-live-caption-display.component.html',
    styleUrl: './settings-live-caption-display.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsLiveCaptionDisplayComponent implements OnInit {
    settings: LiveCaptionDisplaySettings = {
        ...DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS,
    };
    available = false;
    loading = true;
    saving = false;
    error = '';
    saved = false;
    readonly alignments = ['left', 'center', 'right'] as const;
    readonly colors = ['#FFFFFF', '#FFE066', '#66D9FF', '#A6F078', '#FFB3D1'];
    readonly colorFields = [
        { key: 'sourceColor', label: 'ENGLISH_COLOR' },
        { key: 'translatedColor', label: 'CHINESE_COLOR' },
    ] as const;
    readonly positions = [
        { margin: 10.2, label: 'LOW' },
        { margin: 45, label: 'MIDDLE' },
        { margin: 70, label: 'HIGH' },
    ] as const;
    private readonly detector = inject(ChangeDetectorRef);
    private readonly api?: DisplayApi;

    constructor() {
        const bridge = (
            window as Window & { liveCaptions?: Partial<DisplayApi> }
        ).liveCaptions;
        if (
            bridge?.getDisplaySettings &&
            bridge.updateDisplaySettings &&
            bridge.getSupport
        )
            this.api = bridge as DisplayApi;
    }

    ngOnInit(): void {
        void this.load();
    }

    get valid(): boolean {
        const { sourceFontSize, translatedFontSize, bottomMarginPercent } =
            this.settings;
        return (
            Number.isFinite(sourceFontSize) &&
            sourceFontSize >= 24 &&
            sourceFontSize <= 96 &&
            Number.isFinite(translatedFontSize) &&
            translatedFontSize >= 24 &&
            translatedFontSize <= 120 &&
            Number.isFinite(bottomMarginPercent) &&
            bottomMarginPercent >= 4 &&
            bottomMarginPercent <= 75 &&
            this.alignments.includes(this.settings.alignment) &&
            /^#[0-9a-f]{6}$/i.test(this.settings.sourceColor) &&
            /^#[0-9a-f]{6}$/i.test(this.settings.translatedColor)
        );
    }

    get previewSourceBottom(): number {
        return (
            this.settings.bottomMarginPercent +
            (Math.max(
                this.settings.sourceFontSize,
                this.settings.translatedFontSize
            ) +
                20) /
                10.8
        );
    }

    get previewLeft(): number {
        return this.settings.alignment === 'left'
            ? 100 / 24
            : this.settings.alignment === 'right'
              ? 2300 / 24
              : 50;
    }

    get previewTransform(): string {
        return `translateX(${this.settings.alignment === 'left' ? 0 : this.settings.alignment === 'right' ? -100 : -50}%)`;
    }

    changed(): void {
        this.saved = false;
        this.error = '';
    }

    async save(): Promise<void> {
        if (!this.api || !this.available || !this.valid || this.saving) return;
        this.saving = true;
        this.changed();
        try {
            this.settings = await this.api.updateDisplaySettings({
                ...this.settings,
            });
            this.saved = true;
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.saving = false;
            this.detector.markForCheck();
        }
    }

    async reset(): Promise<void> {
        this.settings = { ...DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS };
        await this.save();
    }

    private async load(): Promise<void> {
        try {
            if (!this.api) return;
            this.available = (await this.api.getSupport()).supported;
            if (this.available)
                this.settings = {
                    ...DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS,
                    ...(await this.api.getDisplaySettings()),
                };
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.loading = false;
            this.detector.markForCheck();
        }
    }
}
