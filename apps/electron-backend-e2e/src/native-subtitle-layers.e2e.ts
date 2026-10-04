import {
    addXtreamPortal,
    clickCategoryByNameExact,
    clickGridListCardByTitle,
    closeElectronApp,
    expect,
    launchElectronApp,
    openSettings,
    openSettingsSection,
    saveSettings,
    goToDashboard,
    test,
    waitForXtreamWorkspaceReady,
} from './electron-test-fixtures';
import {
    fetchXtreamVodFixture,
    fetchXtreamSeriesFixture,
    getXtreamTitle,
} from './portal-mock-fixtures';
import {
    createNativeLayerPortal,
    createNativeLayerVideo,
} from './native-subtitle-layers-fixtures';
import { installEmbeddedMpvSessionCapture } from './embedded-mpv-frame-copy-packaged-fixtures';
import { applyTheme } from './theme-contrast';

test('@playback @electron @persistence layers movie and episode source subtitles with independent styles', async ({
    dataDir,
    request,
}, testInfo) => {
    test.setTimeout(120000);
    test.skip(process.platform !== 'win32', 'Windows native-view feature.');
    const video = createNativeLayerVideo(dataDir);
    test.skip(
        !video,
        'FFmpeg is required to generate the embedded text-track fixture.'
    );
    if (!video) return;
    const portal = await createNativeLayerPortal(video);
    const app = await launchElectronApp(dataDir, {
        env: {
            IPTVNATOR_ENABLE_EMBEDDED_MPV_EXPERIMENT: '1',
            IPTVNATOR_ENABLE_EMBEDDED_MPV_FRAME_COPY: '0',
        },
    });
    try {
        const page = app.mainWindow;
        const support = await page.evaluate(() =>
            window.electron.getEmbeddedMpvSupport()
        );
        test.skip(
            !support.capabilities?.nativeSubtitleLayers,
            'Native subtitle layer capability unavailable.'
        );
        await openSettings(page);
        await openSettingsSection(page, 'playback');
        await page.getByTestId('select-video-player').click();
        await page.getByTestId('embedded-mpv').click();
        await saveSettings(page);
        await page.evaluate(() =>
            window.electron.updateSettings({
                embeddedMpvExtraOptions: 'loop-file=inf\nao=null',
            })
        );
        await goToDashboard(page);
        await installEmbeddedMpvSessionCapture(app);
        await app.electronApp.evaluate(() => {
            const captured = globalThis as typeof globalThis & {
                nativeLayerAss: { format: string; data: string }[];
            };
            captured.nativeLayerAss = [];
            const Socket = process.getBuiltinModule('net').Socket;
            const original = Socket.prototype.write;
            Socket.prototype.write = function (
                ...args: Parameters<typeof original>
            ) {
                if (
                    typeof args[0] === 'string' &&
                    args[0].includes('osd-overlay')
                ) {
                    try {
                        const command = JSON.parse(args[0]).command;
                        if (command?.id === 2)
                            captured.nativeLayerAss.push({
                                format: command.format,
                                data: command.data,
                            });
                    } catch {
                        /* Other IPC messages are irrelevant. */
                    }
                }
                return original.apply(this, args);
            };
        });
        await addXtreamPortal(page, {
            name: 'Native layer fixture',
            serverUrl: portal.url,
            username: 'minimal',
            password: 'minimal',
        });
        await waitForXtreamWorkspaceReady(page);
        const vod = await fetchXtreamVodFixture(request);
        const movie = getXtreamTitle(vod.items[0]);
        await page.getByRole('link', { name: 'Movies', exact: true }).click();
        await clickCategoryByNameExact(page, vod.categoryName);
        await clickGridListCardByTitle(page, movie);
        await page.locator('button.play-btn').first().click();
        const state = () =>
            page.evaluate(() => window.__packagedEmbeddedMpvSessions?.at(-1));
        await expect
            .poll(async () => (await state())?.subtitleTracks.length ?? 0)
            .toBe(2);
        const id = (await state())?.id;
        if (!id) throw new Error('Native movie session missing.');
        await page.evaluate(
            (id) => window.electron.setEmbeddedMpvPaused(id, true),
            id
        );
        const player = page.locator('.embedded-mpv-player');
        const open = async () => {
            await player.hover();
            await page
                .getByTestId('embedded-mpv-native-subtitle-layers')
                .click();
        };
        await open();
        await page.getByTestId('native-layer-track-upper').click();
        await page
            .getByRole('option', { name: 'eng · English', exact: true })
            .click();
        await page.getByTestId('native-layer-track-lower').click();
        await page
            .getByRole('option', { name: 'chi · Chinese', exact: true })
            .click();
        await page.getByTestId('native-layer-size-upper').fill('64');
        await page.getByTestId('native-layer-size-lower').fill('72');
        await page.getByTestId('native-layer-position-upper').fill('28.5');
        await page.getByTestId('native-layer-position-lower').fill('12');
        await page.getByTestId('native-layer-color-upper').fill('#bad');
        await expect(page.getByTestId('native-layers-apply')).toBeDisabled();
        await page.getByTestId('native-layer-color-upper').fill('#FFE066');
        await page.getByTestId('native-layer-color-lower').fill('#66D9FF');
        for (const theme of ['light', 'dark'] as const) {
            await applyTheme(page, theme);
            await page
                .getByRole('dialog')
                .screenshot({
                    path: testInfo.outputPath(`native-layers-${theme}.png`),
                });
        }
        await page.getByTestId('native-layers-apply').click();
        await expect(page.getByRole('dialog')).toBeHidden();
        const ass = () =>
            app.electronApp.evaluate(() =>
                (
                    globalThis as typeof globalThis & {
                        nativeLayerAss: { format: string; data: string }[];
                    }
                ).nativeLayerAss.at(-1)
            );
        await expect
            .poll(async () => (await ass())?.data ?? '')
            .toContain('English first line');
        const rendered = (await ass())?.data ?? '';
        expect(rendered).toContain('pos(960,772)');
        expect(rendered).toContain('fs64');
        expect(rendered).toContain('1c&H0066E0FF&');
        expect(rendered).toContain('pos(960,950)');
        expect(rendered).toContain('fs72');
        expect(rendered).toContain('1c&H00FFD966&');
        expect(rendered).toContain('第一条中文字幕');
        await expect
            .poll(async () => (await state())?.selectedSubtitleTrackId)
            .toBe(2);
        await page.evaluate(
            (id) => window.electron.seekEmbeddedMpv(id, 6.5),
            id
        );
        await expect
            .poll(async () => (await ass())?.data ?? '')
            .toContain('English final line');
        await page.evaluate(
            (id) => window.electron.seekEmbeddedMpv(id, 10),
            id
        );
        await expect.poll(async () => (await ass())?.format).toBe('none');
        await page.evaluate((id) => window.electron.seekEmbeddedMpv(id, 1), id);
        await expect
            .poll(async () => (await ass())?.data ?? '')
            .toContain('第一条中文字幕');
        await player.hover();
        await player
            .getByRole('button', { name: 'Enter fullscreen', exact: true })
            .click();
        await expect(player).toHaveClass(/--fullscreen/);
        await player
            .getByRole('button', { name: 'Exit fullscreen', exact: true })
            .click();
        await open();
        await expect(page.getByTestId('native-layer-size-upper')).toHaveValue(
            '64'
        );
        await page.getByTestId('native-layers-disable').click();
        expect(
            (
                await page.evaluate(
                    (id) => window.electron.getEmbeddedMpvSubtitleLayers?.(id),
                    id
                )
            )?.layers
        ).toBeNull();
        // An episode is a new source: choices reset while styles remain.
        await page.getByRole('link', { name: 'Series', exact: true }).click();
        const series = await fetchXtreamSeriesFixture(request);
        await clickCategoryByNameExact(page, series.categoryName);
        await clickGridListCardByTitle(page, getXtreamTitle(series.items[0]));
        await page.locator('.episode-card, .episode-row').first().click();
        await expect
            .poll(async () => (await state())?.subtitleTracks.length ?? 0)
            .toBe(2);
        const episodeId = (await state())?.id;
        if (!episodeId) throw new Error('Native episode session missing.');
        await page.evaluate(
            (id) => window.electron.setEmbeddedMpvPaused(id, true),
            episodeId
        );
        await open();
        await expect(page.getByTestId('native-layer-size-upper')).toHaveValue(
            '64'
        );
        await expect(page.getByTestId('native-layer-color-lower')).toHaveValue(
            '#66D9FF'
        );
        await page.getByTestId('native-layers-apply').click();
        expect(
            (
                await page.evaluate(
                    (id) => window.electron.getEmbeddedMpvSubtitleLayers?.(id),
                    episodeId
                )
            )?.layers
        ).not.toBeNull();
    } finally {
        await closeElectronApp(app);
        await portal.close();
    }
});
