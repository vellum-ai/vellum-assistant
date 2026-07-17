/**
 * Shared PCM sample-rate clamp logic for TTS providers. Each provider keeps
 * its own list of API-supported rates and passes it in.
 */

import type { TtsSynthesisRequest } from "./types.js";

/**
 * Sample rate for PCM requests that carry no `sampleRateHz` hint. The
 * media-stream transcoder assumes headerless PCM is 16 kHz (the shared
 * no-hint default across TTS providers) and downsamples to 8 kHz telephony.
 */
export const DEFAULT_PCM_SAMPLE_RATE_HZ = 16_000;

/** Nearest supported PCM sample rate to `hintHz`; ties prefer the higher rate. */
function nearestSupportedPcmSampleRateHz(
  hintHz: number,
  supportedRatesHz: readonly number[],
): number {
  return supportedRatesHz.reduce((best, rate) => {
    const bestDelta = Math.abs(best - hintHz);
    const delta = Math.abs(rate - hintHz);
    if (delta < bestDelta || (delta === bestDelta && rate > best)) {
      return rate;
    }
    return best;
  });
}

/**
 * Actual PCM output sample rate for a request. A PCM request's hint is clamped
 * to the nearest supported rate so the same value is both sent to the API and
 * reported to callers; non-PCM formats carry their rate in the container and
 * report undefined.
 */
export function resolvePcmOutputSampleRateHz(
  request: TtsSynthesisRequest,
  supportedRatesHz: readonly number[],
): number | undefined {
  if (request.outputFormat !== "pcm") {
    return undefined;
  }
  return nearestSupportedPcmSampleRateHz(
    request.sampleRateHz ?? DEFAULT_PCM_SAMPLE_RATE_HZ,
    supportedRatesHz,
  );
}
