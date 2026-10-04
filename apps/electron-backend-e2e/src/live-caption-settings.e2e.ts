import {
    test,
    expect,
    launchElectronApp,
    closeElectronApp,
    openSettings,
    openSettingsSection,
    restartElectronApp,
    saveSettings,
} from './electron-test-fixtures';

test('@settings @electron @persistence saves AI caption appearance across restart', async ({
    dataDir,
}, testInfo) => {
    test.skip(
        process.platform !== 'win32',
        'Windows native-view captions only.'
    );
    const options = { env: { IPTVNATOR_ENABLE_EMBEDDED_MPV_EXPERIMENT: '1' } };
    let app = await launchElectronApp(dataDir, options);
    try {
        await openSettings(app.mainWindow);
        await openSettingsSection(app.mainWindow, 'playback');
        await app.mainWindow.getByTestId('select-video-player').click();
        await app.mainWindow
            .locator('mat-option')
            .filter({ hasText: /Embedded MPV/i })
            .click();
        await saveSettings(app.mainWindow);
        const row = app.mainWindow.getByTestId('live-caption-display-setting');
        await expect(row).toBeVisible();
        await app.mainWindow.getByTestId('caption-source-font').fill('64');
        await app.mainWindow.getByTestId('caption-translated-font').fill('72');
        await app.mainWindow.getByTestId('caption-bottom-margin').fill('70');
        await app.mainWindow.getByTestId('caption-sourceColor').fill('#bad');
        await expect(
            app.mainWindow.getByTestId('caption-display-save')
        ).toBeDisabled();
        await app.mainWindow.getByTestId('caption-sourceColor').fill('#FFE066');
        await app.mainWindow
            .getByTestId('caption-translatedColor')
            .fill('#66D9FF');
        await app.mainWindow.getByTestId('caption-alignment').click();
        await app.mainWindow.getByTestId('caption-align-right').click();
        await expect(
            app.mainWindow.getByTestId('caption-preview-source')
        ).toHaveCSS('color', 'rgb(255, 224, 102)');
        await expect(
            app.mainWindow.getByTestId('caption-preview-translated')
        ).toHaveCSS('color', 'rgb(102, 217, 255)');
        await app.mainWindow.getByTestId('caption-display-save').click();
        await expect(row.getByRole('status')).toContainText(/Saved|已保存/);
        await row.screenshot({
            path: testInfo.outputPath('caption-appearance-light.png'),
        });
        await openSettingsSection(app.mainWindow, 'general');
        await app.mainWindow.locator('[data-test-id="DARK_THEME"]').click();
        await saveSettings(app.mainWindow);
        await openSettingsSection(app.mainWindow, 'playback');
        await row.screenshot({
            path: testInfo.outputPath('caption-appearance-dark.png'),
        });

        app = await restartElectronApp(app, dataDir, options);
        await openSettings(app.mainWindow);
        await openSettingsSection(app.mainWindow, 'playback');
        await expect(
            app.mainWindow.getByTestId('caption-source-font')
        ).toHaveValue('64');
        await expect(
            app.mainWindow.getByTestId('caption-translated-font')
        ).toHaveValue('72');
        await expect(
            app.mainWindow.getByTestId('caption-bottom-margin')
        ).toHaveValue('70');
        await expect(
            app.mainWindow.getByTestId('caption-sourceColor')
        ).toHaveValue('#FFE066');
        await expect(
            app.mainWindow.getByTestId('caption-translatedColor')
        ).toHaveValue('#66D9FF');
        await expect(
            app.mainWindow.getByTestId('caption-alignment')
        ).toContainText(/Right|靠右/);
        await app.mainWindow.getByTestId('caption-display-reset').click();
        await expect(
            app.mainWindow.getByTestId('caption-source-font')
        ).toHaveValue('42');
        await expect(
            app.mainWindow.getByTestId('caption-translated-font')
        ).toHaveValue('50');
        await expect(
            app.mainWindow.getByTestId('caption-bottom-margin')
        ).toHaveValue('10.2');
        await expect(
            app.mainWindow.getByTestId('caption-sourceColor')
        ).toHaveValue('#FFFFFF');
        await expect(
            app.mainWindow.getByTestId('caption-translatedColor')
        ).toHaveValue('#FFFFFF');
        await expect(
            app.mainWindow.getByTestId('caption-alignment')
        ).toContainText(/Center|居中/);
    } finally {
        await closeElectronApp(app);
    }
});
