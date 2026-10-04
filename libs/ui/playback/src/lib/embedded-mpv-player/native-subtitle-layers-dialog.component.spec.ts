import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import type {
    ElectronBridgeApi,
    NativeSubtitleLayersState,
} from '@iptvnator/shared/interfaces';
import { NativeSubtitleLayersDialogComponent } from './native-subtitle-layers-dialog.component';

describe('native subtitle layers dialog', () => {
    const initial: NativeSubtitleLayersState = {
        playbackRevision: 2,
        selectedPrimaryTrackId: 2,
        layers: null,
        tracks: [
            {
                id: 1,
                title: 'English',
                language: 'eng',
                codec: 'subrip',
                textSupported: true,
            },
            {
                id: 2,
                title: 'Chinese',
                language: 'chi',
                codec: 'ass',
                textSupported: true,
            },
            {
                id: 3,
                title: 'PGS',
                language: '',
                codec: 'hdmv_pgs_subtitle',
                textSupported: false,
            },
        ],
    };
    let original: ElectronBridgeApi;
    let api: {
        getEmbeddedMpvSubtitleLayers: jest.Mock;
        setEmbeddedMpvSubtitleLayers: jest.Mock;
    };
    let close: jest.Mock;
    let current: boolean;
    beforeEach(async () => {
        original = window.electron;
        localStorage.clear();
        current = true;
        api = {
            getEmbeddedMpvSubtitleLayers: jest.fn().mockResolvedValue(initial),
            setEmbeddedMpvSubtitleLayers: jest.fn().mockResolvedValue(initial),
        };
        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: api,
        });
        close = jest.fn();
        await TestBed.configureTestingModule({
            imports: [
                NativeSubtitleLayersDialogComponent,
                TranslateModule.forRoot(),
            ],
            providers: [
                {
                    provide: MAT_DIALOG_DATA,
                    useValue: {
                        sessionId: 'session',
                        isCurrent: () => current,
                    },
                },
                { provide: MatDialogRef, useValue: { close } },
            ],
        }).compileComponents();
    });
    afterEach(() => {
        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: original,
        });
        localStorage.clear();
    });
    async function create() {
        const fixture = TestBed.createComponent(
            NativeSubtitleLayersDialogComponent
        );
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        return fixture;
    }
    it('chooses two different text tracks and applies independent saved styles', async () => {
        const fixture = await create();
        const component = fixture.componentInstance;
        expect(component.draft()?.upper.trackId).toBe(1);
        expect(component.draft()?.lower.trackId).toBe(2);
        component.setStyle('upper', 'fontSize', '64');
        component.setStyle('upper', 'color', '#FFE066');
        component.setStyle('lower', 'bottomMarginPercent', '8');
        component.setStyle('lower', 'color', '#66D9FF');
        await component.apply();
        expect(api.setEmbeddedMpvSubtitleLayers).toHaveBeenCalledWith(
            'session',
            expect.objectContaining({
                upper: expect.objectContaining({
                    style: expect.objectContaining({
                        fontSize: 64,
                        color: '#FFE066',
                    }),
                }),
                lower: expect.objectContaining({
                    style: expect.objectContaining({
                        bottomMarginPercent: 8,
                        color: '#66D9FF',
                    }),
                }),
            }),
            2
        );
        expect(close).toHaveBeenCalledWith(true);
        expect(
            localStorage.getItem('iptvnator.native-subtitle-layer-styles.v1')
        ).toContain('#FFE066');
        fixture.destroy();
    });
    it('disables apply for duplicate tracks, invalid colors and reversed positions', async () => {
        const fixture = await create();
        const component = fixture.componentInstance;
        component.setTrack('upper', 2);
        expect(component.canApply()).toBe(false);
        component.setTrack('upper', 1);
        component.setStyle('upper', 'color', '#bad');
        expect(component.canApply()).toBe(false);
        component.setStyle('upper', 'color', '#FFFFFF');
        component.setStyle('upper', 'bottomMarginPercent', 4);
        expect(component.canApply()).toBe(false);
        component.defaults();
        expect(component.canApply()).toBe(true);
        component.swap();
        expect(component.draft()?.upper.trackId).toBe(2);
        expect(component.draft()?.lower.trackId).toBe(1);
        fixture.destroy();
    });
    it('ignores an old dialog after the movie or episode changes', async () => {
        const fixture = await create();
        current = false;
        await fixture.componentInstance.apply();
        expect(api.setEmbeddedMpvSubtitleLayers).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        expect(fixture.componentInstance.error()).toBeTruthy();
        fixture.destroy();
    });
});
