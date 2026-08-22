export type PlaybackState = {
    readonly duration: number;
    readonly position: number;
};

const UNKNOWN_MEDIA_VALUE = -1;

/**
 * Normalizes AirPlay media timing before exposing it to Homey.
 * Apple devices can occasionally report stale, negative, or non-finite
 * elapsed times, especially after a stereo group pauses or changes leader.
 */
export default function normalizePlaybackState(
    position: number | null | undefined,
    duration: number | null | undefined
): PlaybackState {
    const normalizedDuration = Number.isFinite(duration) && duration! >= 0
        ? duration!
        : UNKNOWN_MEDIA_VALUE;

    let normalizedPosition = Number.isFinite(position) && position! >= 0
        ? position!
        : normalizedDuration >= 0
            ? 0
            : UNKNOWN_MEDIA_VALUE;

    if (normalizedDuration >= 0) {
        normalizedPosition = Math.min(normalizedPosition, normalizedDuration);
    }

    return {
        duration: normalizedDuration,
        position: normalizedPosition
    };
}
