import { writeFileSync } from 'fs';
import { join } from 'path';
import {
    channelItemByTitle,
    closeElectronApp,
    expect,
    goToDashboard,
    importM3uPlaylistFromNativeDialog,
    launchElectronApp,
    openSettings,
    openSettingsSection,
    saveSettings,
    test,
} from './electron-test-fixtures';
import {
    createLocalMediaServer,
    installEmbeddedMpvSessionCapture,
} from './embedded-mpv-frame-copy-packaged-fixtures';
import { applyTheme } from './theme-contrast';

test('@playback @electron native fullscreen releases the hidden controls dock', async ({
    dataDir,
}) => {
    const media = await createLocalMediaServer();
    const app = await launchElectronApp(dataDir, {
        env: {
            IPTVNATOR_ENABLE_EMBEDDED_MPV_EXPERIMENT: '1',
            IPTVNATOR_ENABLE_EMBEDDED_MPV_FRAME_COPY: '0',
        },
    });
    try {
        const support = await app.mainWindow.evaluate(() =>
            window.electron.getEmbeddedMpvSupport()
        );
        test.skip(
            !support.supported || support.engine !== 'native',
            'Native MPV unavailable.'
        );
        await openSettings(app.mainWindow);
        await openSettingsSection(app.mainWindow, 'playback');
        await app.mainWindow.getByTestId('select-video-player').click();
        await app.mainWindow.getByTestId('embedded-mpv').click();
        await saveSettings(app.mainWindow);
        await app.mainWindow.evaluate(() =>
            window.electron.updateSettings({
                embeddedMpvExtraOptions: 'loop-file=inf\nao=null',
            })
        );
        await goToDashboard(app.mainWindow);
        const playlist = join(dataDir, 'fullscreen.m3u');
        writeFileSync(
            playlist,
            `#EXTM3U\n#EXTINF:-1,Fullscreen fixture\n${media.url}\n`
        );
        await installEmbeddedMpvSessionCapture(app);
        await importM3uPlaylistFromNativeDialog(app, playlist);
        await channelItemByTitle(app.mainWindow, 'Fullscreen fixture')
            .first()
            .click();
        await expect
            .poll(() =>
                app.mainWindow.evaluate(
                    () =>
                        window.__packagedEmbeddedMpvSessions?.at(-1)
                            ?.positionSeconds ?? 0
                )
            )
            .toBeGreaterThan(0);
        const player = app.mainWindow.locator('.embedded-mpv-player');
        const viewport = player.locator('.embedded-mpv-player__viewport');
        const controls = player.locator('.embedded-mpv-player__controls');
        const inset = () =>
            viewport.evaluate((el) =>
                Number.parseFloat(getComputedStyle(el).bottom)
            );
        for (const theme of ['light', 'dark'] as const) {
            await applyTheme(app.mainWindow, theme);
            await player.hover();
            await controls
                .getByRole('button', { name: 'Enter fullscreen', exact: true })
                .click();
            await expect(player).toHaveClass(/embedded-mpv-player--fullscreen/);
            await app.mainWindow.mouse.move(10, 10);
            await expect(player).not.toHaveClass(
                /embedded-mpv-player--controls-visible/,
                { timeout: 10000 }
            );
            // Regression: an invisible dock must not shorten the 16:9 viewport.
            await expect.poll(inset).toBe(0);
            const geometry = await player.evaluate((el) => {
                const root = el.getBoundingClientRect();
                const videoElement = el.querySelector(
                    '.embedded-mpv-player__viewport'
                );
                if (!videoElement) throw new Error('Video viewport missing.');
                const video = videoElement.getBoundingClientRect();
                return {
                    height: root.height,
                    videoHeight: video.height,
                    width: root.width,
                    videoWidth: video.width,
                };
            });
            expect(geometry.videoHeight).toBeCloseTo(geometry.height, 0);
            expect(geometry.videoWidth).toBeCloseTo(geometry.width, 0);
            await player.hover();
            await expect(player).toHaveClass(
                /embedded-mpv-player--controls-visible/
            );
            await expect.poll(inset).toBeGreaterThan(0);
            // Optional menus are not exported by every native backend.
            if (support.capabilities?.aspectOverride) {
                await controls
                    .locator('[data-embedded-mpv-menu-button="aspect"]')
                    .click();
                await expect(
                    controls.locator('app-embedded-mpv-dock-panel')
                ).toBeVisible();
                await app.mainWindow.mouse.move(10, 10);
                await app.mainWindow.waitForTimeout(3000);
                await expect(player).toHaveClass(
                    /embedded-mpv-player--controls-visible/
                );
                await expect.poll(inset).toBeGreaterThan(0);
                await controls
                    .locator('.embedded-mpv-dock-panel__back')
                    .click();
            }
            await controls
                .getByRole('button', { name: 'Exit fullscreen', exact: true })
                .click();
            await expect(player).not.toHaveClass(
                /embedded-mpv-player--fullscreen/
            );
            await app.mainWindow.mouse.move(10, 10);
            await expect(player).not.toHaveClass(
                /embedded-mpv-player--controls-visible/,
                { timeout: 10000 }
            );
            await expect.poll(inset).toBeGreaterThan(0);
        }
    } finally {
        await closeElectronApp(app);
        await media.close();
    }
});
