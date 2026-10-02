import { contextBridge, ipcRenderer } from 'electron';
import type {
    LiveCaptionStartOptions,
    LiveCaptionState,
    LiveCaptionSupport,
} from '@iptvnator/shared/interfaces';
import {
    LIVE_CAPTION_GET_STATE,
    LIVE_CAPTION_GET_SUPPORT,
    LIVE_CAPTION_START,
    LIVE_CAPTION_STATE_CHANGED,
    LIVE_CAPTION_STOP,
} from '@iptvnator/shared/interfaces';

export interface LiveCaptionPreloadApi {
    getSupport: () => Promise<LiveCaptionSupport>;
    getState: () => Promise<LiveCaptionState>;
    start: (
        sessionId: string,
        options?: LiveCaptionStartOptions
    ) => Promise<LiveCaptionState>;
    stop: (sessionId?: string) => Promise<LiveCaptionState>;
    onStateChanged: (
        callback: (state: LiveCaptionState) => void
    ) => () => void;
}

if (process.isMainFrame) {
    const api: LiveCaptionPreloadApi = {
        getSupport: () => ipcRenderer.invoke(LIVE_CAPTION_GET_SUPPORT),
        getState: () => ipcRenderer.invoke(LIVE_CAPTION_GET_STATE),
        start: (sessionId, options) =>
            ipcRenderer.invoke(LIVE_CAPTION_START, sessionId, options),
        stop: (sessionId) => ipcRenderer.invoke(LIVE_CAPTION_STOP, sessionId),
        onStateChanged: (callback) => {
            const handler = (
                _event: Electron.IpcRendererEvent,
                state: LiveCaptionState
            ) => callback(state);
            ipcRenderer.on(LIVE_CAPTION_STATE_CHANGED, handler);
            return () => ipcRenderer.off(LIVE_CAPTION_STATE_CHANGED, handler);
        },
    };
    contextBridge.exposeInMainWorld('liveCaptions', api);
}
