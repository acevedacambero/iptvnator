import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    closeElectronApp,
    expect,
    launchElectronApp,
    test,
    workspaceRoot,
} from './electron-test-fixtures';
import { installEmbeddedMpvSessionCapture } from './embedded-mpv-frame-copy-packaged-fixtures';

test('@playback @electron source subtitles start disabled for live playback and remain automatic for VOD', async ({
    dataDir,
}) => {
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
            !support.supported ||
                support.engine !== 'native' ||
                !support.capabilities?.subtitles,
            'Native subtitle control unavailable.'
        );
        const video = join(dataDir, 'subtitle-fixture.webm');
        copyFileSync(
            join(
                workspaceRoot,
                'apps/web-e2e/src/fixtures/playback/episode.webm'
            ),
            video
        );
        writeFileSync(
            join(dataDir, 'subtitle-fixture.srt'),
            '1\n00:00:00,000 --> 00:10:00,000\nSource subtitle fixture\n'
        );
        await app.mainWindow.evaluate(() =>
            window.electron.updateSettings({
                embeddedMpvExtraOptions: 'loop-file=inf\nao=null',
            })
        );
        await installEmbeddedMpvSessionCapture(app);
        const id = await app.mainWindow.evaluate(async (video) => {
            const session = await window.electron.createEmbeddedMpvSession(
                { x: 320, y: 120, width: 640, height: 360 },
                'Subtitle policy fixture',
                0
            );
            await window.electron.loadEmbeddedMpvPlayback(session.id, {
                streamUrl: video,
                title: 'Live fixture',
                isLive: true,
            });
            return session.id;
        }, video);
        const state = () =>
            app.mainWindow.evaluate(() =>
                window.__packagedEmbeddedMpvSessions?.at(-1)
            );
        await expect
            .poll(async () => (await state())?.subtitleTracks.length ?? 0)
            .toBeGreaterThan(0);
        await expect
            .poll(async () => (await state())?.selectedSubtitleTrackId)
            .toBeNull();
        const track = (await state())?.subtitleTracks[0]?.id;
        if (typeof track !== 'number')
            throw new Error('Fixture subtitle track missing.');
        await app.mainWindow.evaluate(
            ({ id, track }) =>
                window.electron.setEmbeddedMpvSubtitleTrack?.(id, track),
            { id, track }
        );
        await expect
            .poll(async () => (await state())?.selectedSubtitleTrackId)
            .toBe(track);
        await app.mainWindow.evaluate(
            ({ id, video }) =>
                window.electron.loadEmbeddedMpvPlayback(id, {
                    streamUrl: video,
                    title: 'Next live fixture',
                    isLive: true,
                }),
            { id, video }
        );
        await expect
            .poll(async () => (await state())?.selectedSubtitleTrackId)
            .toBeNull();
        await app.mainWindow.evaluate(
            ({ id, video }) =>
                window.electron.loadEmbeddedMpvPlayback(id, {
                    streamUrl: video,
                    title: 'VOD fixture',
                    isLive: false,
                }),
            { id, video }
        );
        await expect
            .poll(async () => (await state())?.selectedSubtitleTrackId ?? -1)
            .toBeGreaterThan(0);
        await app.mainWindow.evaluate(
            (id) => window.electron.disposeEmbeddedMpvSession(id),
            id
        );
    } finally {
        await closeElectronApp(app);
    }
});
