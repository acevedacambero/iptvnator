import { TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { SettingsLiveCaptionDisplayComponent } from './settings-live-caption-display.component';
import { DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS } from '@iptvnator/shared/interfaces';

describe('Caption display settings', () => {
    const settings = {
        ...DEFAULT_LIVE_CAPTION_DISPLAY_SETTINGS,
        sourceFontSize: 42,
        translatedFontSize: 50,
        bottomMarginPercent: 10.2,
    };
    let update: jest.Mock;
    beforeEach(async () => {
        update = jest.fn().mockImplementation(async (value) => value);
        Object.defineProperty(window, 'liveCaptions', {
            configurable: true,
            value: {
                getSupport: async () => ({ supported: true }),
                getDisplaySettings: async () => settings,
                updateDisplaySettings: update,
            },
        });
        await TestBed.configureTestingModule({
            imports: [
                SettingsLiveCaptionDisplayComponent,
                NoopAnimationsModule,
                TranslateModule.forRoot(),
            ],
        }).compileComponents();
    });
    afterEach(() => Reflect.deleteProperty(window, 'liveCaptions'));

    it('persists changes, blocks invalid input, and resets defaults', async () => {
        const fixture = TestBed.createComponent(
            SettingsLiveCaptionDisplayComponent
        );
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        const component = fixture.componentInstance;
        expect(
            fixture.nativeElement.querySelector(
                '[data-test-id="caption-source-font"]'
            )
        ).toBeTruthy();
        component.settings = {
            ...settings,
            sourceFontSize: 64,
            alignment: 'right',
            sourceColor: '#FFE066',
            translatedColor: '#66D9FF',
        };
        await component.save();
        expect(update).toHaveBeenCalledWith({
            ...settings,
            sourceFontSize: 64,
            alignment: 'right',
            sourceColor: '#FFE066',
            translatedColor: '#66D9FF',
        });
        component.settings.bottomMarginPercent = 90;
        await component.save();
        expect(update).toHaveBeenCalledTimes(1);
        await component.reset();
        expect(update).toHaveBeenLastCalledWith(settings);
    });
    it('previews color and position edits and prevents invalid colors from being saved', async () => {
        const fixture = TestBed.createComponent(
            SettingsLiveCaptionDisplayComponent
        );
        fixture.detectChanges();
        await fixture.whenStable();
        const component = fixture.componentInstance;
        component.settings = {
            ...settings,
            bottomMarginPercent: 70,
            alignment: 'left',
            sourceColor: '#FFE066',
        };
        fixture.changeDetectorRef.markForCheck();
        fixture.detectChanges();
        const preview = fixture.nativeElement.querySelector(
            '[data-test-id="caption-preview-source"]'
        ) as HTMLElement;
        expect(preview.style.color).toBe('rgb(255, 224, 102)');
        expect(parseFloat(preview.style.left)).toBeCloseTo(100 / 24, 3);
        expect(parseFloat(preview.style.bottom)).toBeGreaterThan(70);
        component.settings.sourceColor = '#invalid';
        await component.save();
        expect(update).not.toHaveBeenCalled();
    });
    it('shows save failure without losing the editable values', async () => {
        const fixture = TestBed.createComponent(
            SettingsLiveCaptionDisplayComponent
        );
        fixture.detectChanges();
        await fixture.whenStable();
        update.mockRejectedValueOnce(new Error('disk unavailable'));
        await fixture.componentInstance.save();
        expect(fixture.componentInstance.error).toBe('disk unavailable');
        expect(fixture.componentInstance.settings).toEqual(settings);
        expect(fixture.componentInstance.saving).toBe(false);
    });
});
