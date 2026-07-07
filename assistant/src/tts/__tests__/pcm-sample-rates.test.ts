import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PCM_SAMPLE_RATE_HZ,
  nearestSupportedPcmSampleRateHz,
  resolvePcmOutputSampleRateHz,
} from "../pcm-sample-rates.js";
import type { TtsSynthesisRequest } from "../types.js";

const RATES = [8_000, 16_000, 24_000, 32_000, 44_100] as const;

function makeRequest(
  overrides?: Partial<TtsSynthesisRequest>,
): TtsSynthesisRequest {
  return {
    text: "Hello world",
    useCase: "message-playback",
    ...overrides,
  };
}

describe("nearestSupportedPcmSampleRateHz", () => {
  test("returns an exact match unchanged", () => {
    expect(nearestSupportedPcmSampleRateHz(24_000, RATES)).toBe(24_000);
  });

  test("clamps to the nearest rate below", () => {
    expect(nearestSupportedPcmSampleRateHz(48_000, RATES)).toBe(44_100);
  });

  test("clamps to the nearest rate above", () => {
    expect(nearestSupportedPcmSampleRateHz(7_000, RATES)).toBe(8_000);
  });

  test("ties prefer the higher rate", () => {
    expect(nearestSupportedPcmSampleRateHz(12_000, RATES)).toBe(16_000);
  });
});

describe("resolvePcmOutputSampleRateHz", () => {
  test("returns undefined for non-PCM requests", () => {
    expect(
      resolvePcmOutputSampleRateHz(makeRequest({ sampleRateHz: 24_000 }), RATES),
    ).toBeUndefined();
  });

  test("defaults hint-less PCM requests to 16 kHz", () => {
    expect(
      resolvePcmOutputSampleRateHz(makeRequest({ outputFormat: "pcm" }), RATES),
    ).toBe(DEFAULT_PCM_SAMPLE_RATE_HZ);
  });

  test("clamps a PCM hint to the nearest supported rate", () => {
    expect(
      resolvePcmOutputSampleRateHz(
        makeRequest({ outputFormat: "pcm", sampleRateHz: 48_000 }),
        RATES,
      ),
    ).toBe(44_100);
  });
});
