import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PCM_SAMPLE_RATE_HZ,
  resolvePcmOutputSampleRateHz,
} from "../pcm-sample-rates.js";
import type { TtsSynthesisRequest } from "../types.js";

const RATES = [8_000, 16_000, 24_000, 32_000, 44_100] as const;

function makePcmRequest(sampleRateHz?: number): TtsSynthesisRequest {
  return {
    text: "Hello world",
    useCase: "message-playback",
    outputFormat: "pcm",
    sampleRateHz,
  };
}

describe("resolvePcmOutputSampleRateHz", () => {
  test("returns undefined for non-PCM requests", () => {
    const request: TtsSynthesisRequest = {
      text: "Hello world",
      useCase: "message-playback",
      sampleRateHz: 24_000,
    };
    expect(resolvePcmOutputSampleRateHz(request, RATES)).toBeUndefined();
  });

  test("defaults hint-less PCM requests to 16 kHz", () => {
    expect(resolvePcmOutputSampleRateHz(makePcmRequest(), RATES)).toBe(
      DEFAULT_PCM_SAMPLE_RATE_HZ,
    );
  });

  test("returns an exact-match hint unchanged", () => {
    expect(resolvePcmOutputSampleRateHz(makePcmRequest(24_000), RATES)).toBe(
      24_000,
    );
  });

  test("clamps a hint to the nearest rate below", () => {
    expect(resolvePcmOutputSampleRateHz(makePcmRequest(48_000), RATES)).toBe(
      44_100,
    );
  });

  test("clamps a hint to the nearest rate above", () => {
    expect(resolvePcmOutputSampleRateHz(makePcmRequest(7_000), RATES)).toBe(
      8_000,
    );
  });

  test("ties prefer the higher rate", () => {
    expect(resolvePcmOutputSampleRateHz(makePcmRequest(12_000), RATES)).toBe(
      16_000,
    );
  });
});
