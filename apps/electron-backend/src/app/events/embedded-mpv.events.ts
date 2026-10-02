import { ipcMain } from 'electron';
import {
    EMBEDDED_MPV_ADD_SUBTITLE,
    EMBEDDED_MPV_CLEAR_AI_CAPTION_OVERLAY,
    EMBEDDED_MPV_CREATE_SESSION,
    EMBEDDED_MPV_DISPOSE_SESSION,
    EMBEDDED_MPV_GET_FRAME_SOURCE,
    EMBEDDED_MPV_LOAD_PLAYBACK,
    EMBEDDED_MPV_PREPARE,
    EMBEDDED_MPV_SEEK,
    EMBEDDED_MPV_SEEK_BY,
    EMBEDDED_MPV_SELECT_SUBTITLE_FILE,
    EMBEDDED_MPV_SET_AI_CAPTION_OVERLAY,
    EMBEDDED_MPV_SET_ASPECT,
    EMBEDDED_MPV_SET_AUDIO_TRACK,
    EMBEDDED_MPV_SET_BOUNDS,
    EMBEDDED_MPV_SET_PAUSED,
    EMBEDDED_MPV_SET_SPEED,
    EMBEDDED_MPV_SET_SUBTITLE_DELAY,
    EMBEDDED_MPV_SET_SUBTITLE_STYLE,
    EMBEDDED_MPV_SET_SUBTITLE_TRACK,
    EMBEDDED_MPV_SET_VOLUME,
    EmbeddedMpvAiCaptionOverlay,
    EmbeddedMpvSubtitleStyle,
    EMBEDDED_MPV_GET_DEFAULT_RECORDING_FOLDER,
    EMBEDDED_MPV_SELECT_RECORDING_FOLDER,
    EMBEDDED_MPV_START_RECORDING,
    EMBEDDED_MPV_STOP_RECORDING,
    EMBEDDED_MPV_SUPPORT,
    EmbeddedMpvBounds,
    EmbeddedMpvRecordingStartOptions,
    EmbeddedMpvSupport,
    LIVE_CAPTION_GET_STATE,
    LIVE_CAPTION_GET_SUPPORT,
    LIVE_CAPTION_START,
    LIVE_CAPTION_STATE_CHANGED,
    LIVE_CAPTION_STOP,
    LiveCaptionStartOptions,
    ResolvedPortalPlayback,
} from '@iptvnator/shared/interfaces';
import App from '../app';
import {
    EmbeddedMpvNativeService,
    embeddedMpvNativeService,
} from '../services/embedded-mpv-native.service';
import { readEmbeddedMpvSessionOptions } from '../services/embedded-mpv-session-options';
import { buildAiCaptionAssOverlay } from '../services/live-caption/ai-caption-ass';
import { liveCaptionMpvOverlayService } from '../services/live-caption/live-caption-mpv-overlay.service';
import { liveCaptionService } from '../services/live-caption/live-caption.service';

const AI_CAPTION_P0_TEST_ENV = 'IPTVNATOR_AI_CAPTION_P0_TEST';

export default class EmbeddedMpvEvents {
    static bootstrapEmbeddedMpvEvents(): Electron.IpcMain {
        return ipcMain;
    }
}

function getService(): EmbeddedMpvNativeService {
    return embeddedMpvNativeService;
}

function isAiCaptionP0TestEnabled(): boolean {
    return ['1', 'true', 'yes', 'on'].includes(
        (process.env[AI_CAPTION_P0_TEST_ENV] ?? '').trim().toLowerCase()
    );
}

function withAiCaptionSupport(support: EmbeddedMpvSupport): EmbeddedMpvSupport {
    if (
        !support.supported ||
        support.platform !== 'win32' ||
        support.engine !== 'native' ||
        !support.capabilities
    ) {
        return support;
    }
    return {
        ...support,
        capabilities: {
            ...support.capabilities,
            aiCaptionOverlay: true,
        },
    };
}

/**
 * Registers an embedded-MPV IPC handler that logs failures in the main
 * process before rethrowing them to the renderer. The renderer swallows
 * these rejections (the next session snapshot resyncs its state), so
 * without main-side logging addon errors would be invisible.
 */
function handleEmbeddedMpv<Args extends unknown[]>(
    channel: string,
    handler: (...args: Args) => unknown
): void {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
        try {
            return await handler(...(args as Args));
        } catch (error) {
            console.error(`[Embedded MPV] ${channel} handler failed:`, error);
            throw error;
        }
    });
}

handleEmbeddedMpv(EMBEDDED_MPV_SUPPORT, () =>
    withAiCaptionSupport(getService().getSupport())
);

handleEmbeddedMpv(EMBEDDED_MPV_PREPARE, () =>
    withAiCaptionSupport(getService().prepareAddon())
);

handleEmbeddedMpv(LIVE_CAPTION_GET_SUPPORT, () =>
    liveCaptionService.getSupport()
);
handleEmbeddedMpv(LIVE_CAPTION_GET_STATE, () => liveCaptionService.getState());
handleEmbeddedMpv(
    LIVE_CAPTION_START,
    (sessionId: string, options?: LiveCaptionStartOptions) =>
        liveCaptionService.start(sessionId, options)
);
handleEmbeddedMpv(LIVE_CAPTION_STOP, (sessionId?: string) =>
    liveCaptionService.stop(sessionId)
);

liveCaptionService.subscribe((state) => {
    if (!App.mainWindow || App.mainWindow.isDestroyed()) {
        return;
    }
    App.mainWindow.webContents.send(LIVE_CAPTION_STATE_CHANGED, state);
});

handleEmbeddedMpv(
    EMBEDDED_MPV_CREATE_SESSION,
    (bounds: EmbeddedMpvBounds, title?: string, initialVolume?: number) => {
        // Windows native-view gets a private JSON IPC pipe for AI captions.
        // The path is injected after the user's extra options so a Settings
        // line cannot redirect this security-sensitive control channel.
        const options = readEmbeddedMpvSessionOptions();
        const enableAiCaptionPipe =
            process.platform === 'win32' &&
            getService().getActiveEngine() === 'native';
        const pipePath = enableAiCaptionPipe
            ? liveCaptionMpvOverlayService.createPipePath()
            : null;
        const session = getService().createSession(
            bounds,
            title,
            initialVolume,
            pipePath
                ? {
                      ...options,
                      extraOptions: [
                          ...options.extraOptions,
                          `input-ipc-server=${pipePath}`,
                      ],
                  }
                : options
        );
        if (pipePath) {
            liveCaptionMpvOverlayService.registerSession(session.id, pipePath);
        }
        return session;
    }
);

handleEmbeddedMpv(
    EMBEDDED_MPV_LOAD_PLAYBACK,
    async (sessionId: string, playback: ResolvedPortalPlayback) => {
        // A new file behind the same libmpv session is a new caption
        // generation. Stop capture first so a late ASR result can never paint
        // over the replacement channel/programme.
        await liveCaptionService.stop(sessionId);
        const result = getService().loadPlayback(sessionId, playback);
        // P0 probe: opt-in only. It proves the full Windows libmpv named-pipe
        // -> JSON IPC -> ASS OSD path (including Chinese glyph rendering)
        // before WASAPI/Whisper are introduced. Normal builds never show it.
        if (
            isAiCaptionP0TestEnabled() &&
            process.platform === 'win32' &&
            getService().getActiveEngine() === 'native'
        ) {
            await liveCaptionMpvOverlayService.setOverlay(
                sessionId,
                buildAiCaptionAssOverlay({
                    mode: 'bilingual',
                    sourceText: 'IPTVnator AI live captions — P0 overlay path active',
                    translatedText: 'IPTVnator AI 实时双语字幕 — P0 显示通道已启用',
                })
            );
        }
        return result;
    }
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_BOUNDS,
    (sessionId: string, bounds: EmbeddedMpvBounds) =>
        getService().setBounds(sessionId, bounds)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_PAUSED,
    (sessionId: string, paused: boolean) =>
        getService().setPaused(sessionId, paused)
);

handleEmbeddedMpv(EMBEDDED_MPV_SEEK, (sessionId: string, seconds: number) =>
    getService().seek(sessionId, seconds)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SEEK_BY,
    (sessionId: string, deltaSeconds: number) =>
        getService().seekBy(sessionId, deltaSeconds)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_VOLUME,
    (sessionId: string, volume: number) =>
        getService().setVolume(sessionId, volume)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_AUDIO_TRACK,
    (sessionId: string, trackId: number) =>
        getService().setAudioTrack(sessionId, trackId)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_SUBTITLE_TRACK,
    (sessionId: string, trackId: number) =>
        getService().setSubtitleTrack(sessionId, trackId)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_ADD_SUBTITLE,
    (sessionId: string, filePath: string) =>
        getService().addSubtitle(sessionId, filePath)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_SUBTITLE_DELAY,
    (sessionId: string, seconds: number) =>
        getService().setSubtitleDelay(sessionId, seconds)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_SUBTITLE_STYLE,
    (sessionId: string, style: EmbeddedMpvSubtitleStyle) =>
        getService().setSubtitleStyle(sessionId, style)
);

handleEmbeddedMpv(EMBEDDED_MPV_SELECT_SUBTITLE_FILE, () =>
    getService().selectSubtitleFile()
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_AI_CAPTION_OVERLAY,
    (sessionId: string, overlay: EmbeddedMpvAiCaptionOverlay) =>
        liveCaptionMpvOverlayService.setOverlay(sessionId, overlay)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_CLEAR_AI_CAPTION_OVERLAY,
    (sessionId: string) => liveCaptionMpvOverlayService.clearOverlay(sessionId)
);

handleEmbeddedMpv(EMBEDDED_MPV_SET_SPEED, (sessionId: string, speed: number) =>
    getService().setSpeed(sessionId, speed)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_ASPECT,
    (sessionId: string, aspect: string) =>
        getService().setAspect(sessionId, aspect)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_START_RECORDING,
    (sessionId: string, options: EmbeddedMpvRecordingStartOptions) =>
        getService().startRecording(sessionId, options)
);

handleEmbeddedMpv(EMBEDDED_MPV_STOP_RECORDING, (sessionId: string) =>
    getService().stopRecording(sessionId)
);

handleEmbeddedMpv(EMBEDDED_MPV_GET_DEFAULT_RECORDING_FOLDER, () =>
    getService().getDefaultRecordingFolder()
);

handleEmbeddedMpv(EMBEDDED_MPV_SELECT_RECORDING_FOLDER, () =>
    getService().selectRecordingFolder()
);

handleEmbeddedMpv(
    EMBEDDED_MPV_DISPOSE_SESSION,
    async (sessionId: string) => {
        await liveCaptionService.stop(sessionId);
        liveCaptionMpvOverlayService.disposeSession(sessionId);
        return getService().disposeSession(sessionId);
    }
);

handleEmbeddedMpv(EMBEDDED_MPV_GET_FRAME_SOURCE, (sessionId: string) =>
    getService().getFrameSource(sessionId)
);

export function shutdownEmbeddedMpv(): void {
    liveCaptionService.shutdown();
    liveCaptionMpvOverlayService.shutdown();
    getService().shutdown();
}
