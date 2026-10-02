import { CommonModule } from '@angular/common';
import { Component, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type {
    LiveCaptionTranslationSettings,
    LiveCaptionTranslationSettingsUpdate,
} from '@iptvnator/shared/interfaces';

interface LiveCaptionTranslationSettingsApi {
    getTranslationSettings: () => Promise<LiveCaptionTranslationSettings>;
    updateTranslationSettings: (
        patch: LiveCaptionTranslationSettingsUpdate
    ) => Promise<LiveCaptionTranslationSettings>;
}

type CaptionWindow = Window & {
    liveCaptions?: Partial<LiveCaptionTranslationSettingsApi>;
};

@Component({
    selector: 'app-settings-live-caption-translation',
    imports: [
        CommonModule,
        FormsModule,
        MatButtonModule,
        MatCheckboxModule,
        MatFormFieldModule,
        MatInputModule,
    ],
    templateUrl: './settings-live-caption-translation.component.html',
    changeDetection: ChangeDetectionStrategy.Eager,
    styles: [
        `
            :host {
                display: contents;
            }
            .live-caption-translation-fields {
                display: grid;
                gap: 12px;
                min-width: min(420px, 100%);
            }
            .live-caption-translation-actions {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 8px;
            }
            .live-caption-translation-status {
                font-size: 12px;
                opacity: 0.8;
            }
            .live-caption-translation-error {
                font-size: 12px;
                color: var(--mat-sys-error, #ba1a1a);
            }
        `,
    ],
})
export class SettingsLiveCaptionTranslationComponent implements OnInit {
    enabled = false;
    baseUrl = 'https://api.openai.com/v1';
    model = '';
    targetLanguage = 'Simplified Chinese';
    apiKey = '';
    hasApiKey = false;
    encryptionAvailable = false;
    loading = true;
    saving = false;
    error = '';
    saved = '';

    private readonly api?: LiveCaptionTranslationSettingsApi;

    constructor() {
        const bridge =
            typeof window === 'undefined'
                ? undefined
                : (window as CaptionWindow).liveCaptions;
        if (
            bridge?.getTranslationSettings &&
            bridge.updateTranslationSettings
        ) {
            this.api = bridge as LiveCaptionTranslationSettingsApi;
        }
    }

    get available(): boolean {
        return Boolean(this.api);
    }

    ngOnInit(): void {
        void this.load();
    }

    async save(): Promise<void> {
        if (!this.api || this.saving) {
            return;
        }
        this.error = '';
        this.saved = '';
        this.saving = true;
        try {
            const patch: LiveCaptionTranslationSettingsUpdate = {
                enabled: this.enabled,
                provider: 'openai-compatible',
                baseUrl: this.baseUrl,
                model: this.model,
                targetLanguage: this.targetLanguage,
            };
            if (this.apiKey.trim()) {
                patch.apiKey = this.apiKey;
            }
            const next = await this.api.updateTranslationSettings(patch);
            this.apiKey = '';
            this.apply(next);
            this.saved = 'Saved securely.';
        } catch (error) {
            this.error = this.message(error);
        } finally {
            this.saving = false;
        }
    }

    async clearApiKey(): Promise<void> {
        if (!this.api || this.saving) {
            return;
        }
        this.error = '';
        this.saved = '';
        this.saving = true;
        try {
            const next = await this.api.updateTranslationSettings({
                clearApiKey: true,
                enabled: false,
            });
            this.apiKey = '';
            this.apply(next);
            this.saved = 'API key removed.';
        } catch (error) {
            this.error = this.message(error);
        } finally {
            this.saving = false;
        }
    }

    private async load(): Promise<void> {
        if (!this.api) {
            this.loading = false;
            return;
        }
        try {
            this.apply(await this.api.getTranslationSettings());
        } catch (error) {
            this.error = this.message(error);
        } finally {
            this.loading = false;
        }
    }

    private apply(settings: LiveCaptionTranslationSettings): void {
        this.enabled = settings.enabled;
        this.baseUrl = settings.baseUrl;
        this.model = settings.model;
        this.targetLanguage = settings.targetLanguage;
        this.hasApiKey = settings.hasApiKey;
        this.encryptionAvailable = settings.encryptionAvailable;
    }

    private message(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
