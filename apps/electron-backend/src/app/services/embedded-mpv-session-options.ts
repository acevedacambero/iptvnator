import { resolveEmbeddedMpvSessionOptionArguments } from '@iptvnator/shared/interfaces';
import {
    EMBEDDED_MPV_AUTO_RECONNECT,
    EMBEDDED_MPV_EXTRA_OPTIONS,
    store,
} from './store.service';

/**
 * Temporary, opt-in startup-latency profiles used to isolate the Windows
 * native-view 20-30 second TTFF regression. They are deliberately selected
 * by an environment variable rather than persisted settings, so one packaged
 * build can run repeatable A/B tests without changing normal playback.
 */
const EMBEDDED_MPV_TTFF_PROFILE_ENV = 'IPTVNATOR_EMBEDDED_MPV_TTFF_PROFILE';

type EmbeddedMpvTtffProfile = 'baseline' | 'hwdec-off' | 'cache-off';

function resolveTtffDiagnosticOptions(): string[] {
    const raw = (process.env[EMBEDDED_MPV_TTFF_PROFILE_ENV] ?? '')
        .trim()
        .toLowerCase();
    const profile: EmbeddedMpvTtffProfile =
        raw === 'hwdec-off' || raw === 'cache-off' ? raw : 'baseline';

    if (profile === 'hwdec-off') {
        // mpv itself defaults to software decoding. IPTVnator currently forces
        // hwdec=auto-safe on Windows, so this isolates D3D11/hardware-decoder
        // negotiation without changing any other startup behavior.
        return ['hwdec=no'];
    }
    if (profile === 'cache-off') {
        // Diagnostic only. If TTFF collapses here, the delay lives in mpv's
        // network/demuxer cache path rather than decoder/video-output setup.
        return ['cache=no'];
    }
    return [];
}

/**
 * Per-session knobs captured when an embedded MPV session is created. They
 * come from the main-process settings mirror (see `store.service.ts`), so a
 * settings change applies to the next session, never to a running one.
 *
 * Read here rather than inside `EmbeddedMpvNativeService`: the config store
 * is constructed at module load and would drag electron-conf into every
 * consumer of the service, including its unit tests.
 */
export interface EmbeddedMpvSessionOptions {
    /**
     * `key=value` lines the addon applies after its built-in options: the
     * network defaults first, then the user's allowed lines.
     */
    extraOptions: string[];
    /** Reload a dropped stream automatically (see `embedded-mpv-reconnect.ts`). */
    autoReconnect: boolean;
}

export function readEmbeddedMpvSessionOptions(): EmbeddedMpvSessionOptions {
    const configuredOptions = resolveEmbeddedMpvSessionOptionArguments(
        store.get(EMBEDDED_MPV_EXTRA_OPTIONS, '')
    );
    const diagnosticOptions = resolveTtffDiagnosticOptions();
    if (diagnosticOptions.length > 0) {
        console.warn(
            `[Embedded MPV][TTFF] diagnostic profile ${process.env[EMBEDDED_MPV_TTFF_PROFILE_ENV]} active: ${diagnosticOptions.join(', ')}`
        );
    }

    return {
        // Diagnostic options go last on purpose: they must override both the
        // engine built-ins and any persisted line for this one A/B run.
        extraOptions: [...configuredOptions, ...diagnosticOptions],
        autoReconnect: store.get(EMBEDDED_MPV_AUTO_RECONNECT, true) !== false,
    };
}
