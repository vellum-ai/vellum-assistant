/**
 * OpenRouter is the one catalog provider that publishes machine-readable
 * prices for every id. These tests keep the `openrouter` block of
 * `model-catalog.ts` aligned with https://openrouter.ai/api/v1/models.
 *
 * Local invariants always run. The live fetch fails the build on missing
 * ids or capability mismatches when the endpoint is reachable. Rate drift
 * is reported as a warning: OpenRouter reprices on its own clock, and
 * failing the suite on that would red every merge until someone recopies
 * the card. The fetch skips (does not fail) when the endpoint is not
 * reachable, so CI is not hostage to a network blip.
 */

import { describe, expect, test } from "bun:test";

import { PROVIDER_CATALOG } from "../providers/model-catalog.js";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const RATE_TOLERANCE = 0.02;
const LIVE_FETCH_TIMEOUT_MS = 15_000;

interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

interface OpenRouterModel {
  id: string;
  pricing?: OpenRouterPricing;
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[];
}

function perMillionFromOpenRouterPrice(
  raw: string | number | undefined | null,
): number | undefined {
  if (raw == null || raw === "") {
    return undefined;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n === 0) {
    return undefined;
  }
  return n * 1_000_000;
}

function rateDiffers(
  catalog: number | undefined,
  live: number | undefined,
  tolerance = RATE_TOLERANCE,
): boolean {
  if (catalog === undefined && live === undefined) {
    return false;
  }
  if (catalog === undefined || live === undefined) {
    return true;
  }
  const denom = Math.max(Math.abs(live), Math.abs(catalog), Number.EPSILON);
  return Math.abs(catalog - live) / denom > tolerance;
}

function openrouterCatalogModels() {
  const entry = PROVIDER_CATALOG.find((provider) => provider.id === "openrouter");
  if (!entry) {
    throw new Error("PROVIDER_CATALOG is missing the openrouter entry");
  }
  return entry.models;
}

describe("OpenRouter catalog parity helpers", () => {
  test("treats a zero OpenRouter price as absent", () => {
    expect(perMillionFromOpenRouterPrice("0")).toBeUndefined();
    expect(perMillionFromOpenRouterPrice(0)).toBeUndefined();
  });

  test("converts per-token OpenRouter prices to per-1M", () => {
    expect(perMillionFromOpenRouterPrice("0.000002")).toBeCloseTo(2, 10);
    expect(perMillionFromOpenRouterPrice("0.0000000435145")).toBeCloseTo(
      0.0435145,
      10,
    );
  });

  test("rateDiffers uses a 2% relative band", () => {
    expect(rateDiffers(1, 1.019)).toBe(false);
    expect(rateDiffers(1, 1.021)).toBe(true);
    expect(rateDiffers(0.55, 0.5)).toBe(true);
    expect(rateDiffers(undefined, 0.3)).toBe(true);
    expect(rateDiffers(undefined, undefined)).toBe(false);
  });
});

describe("OpenRouter catalog vs live OpenRouter card", () => {
  test(
    "catalog ids exist and caching flags match the live OpenRouter card",
    async () => {
      let payload: OpenRouterModelsResponse;
      try {
        const response = await fetch(OPENROUTER_MODELS_URL, {
          signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          console.warn(
            `Skipping live OpenRouter catalog check: HTTP ${response.status}`,
          );
          return;
        }
        payload = (await response.json()) as OpenRouterModelsResponse;
      } catch (error) {
        console.warn(
          `Skipping live OpenRouter catalog check: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }

      const liveModels = payload.data;
      expect(
        Array.isArray(liveModels) && liveModels.length > 0,
        "OpenRouter /api/v1/models returned no models",
      ).toBe(true);

      const liveById = new Map(
        (liveModels ?? []).map((model) => [model.id, model]),
      );
      const blocking: string[] = [];
      const rateDrifts: string[] = [];

      for (const model of openrouterCatalogModels()) {
        const live = liveById.get(model.id);
        if (!live) {
          blocking.push(`${model.id}: missing from OpenRouter catalog`);
          continue;
        }

        const liveInput = perMillionFromOpenRouterPrice(live.pricing?.prompt);
        const liveOutput = perMillionFromOpenRouterPrice(
          live.pricing?.completion,
        );
        const liveCacheRead = perMillionFromOpenRouterPrice(
          live.pricing?.input_cache_read,
        );
        const liveCacheWrite = perMillionFromOpenRouterPrice(
          live.pricing?.input_cache_write,
        );

        if (rateDiffers(model.pricing?.inputPer1mTokens, liveInput)) {
          rateDrifts.push(
            `${model.id}: input ${model.pricing?.inputPer1mTokens} vs OpenRouter ${liveInput}`,
          );
        }
        if (rateDiffers(model.pricing?.outputPer1mTokens, liveOutput)) {
          rateDrifts.push(
            `${model.id}: output ${model.pricing?.outputPer1mTokens} vs OpenRouter ${liveOutput}`,
          );
        }
        if (rateDiffers(model.pricing?.cacheReadPer1mTokens, liveCacheRead)) {
          rateDrifts.push(
            `${model.id}: cacheRead ${model.pricing?.cacheReadPer1mTokens} vs OpenRouter ${liveCacheRead}`,
          );
        }
        if (
          liveCacheWrite !== undefined &&
          rateDiffers(model.pricing?.cacheWritePer1mTokens, liveCacheWrite)
        ) {
          rateDrifts.push(
            `${model.id}: cacheWrite ${model.pricing?.cacheWritePer1mTokens} vs OpenRouter ${liveCacheWrite}`,
          );
        }

        const isXai = model.id.startsWith("x-ai/");
        if (liveCacheRead !== undefined && !isXai && !model.supportsCaching) {
          blocking.push(
            `${model.id}: OpenRouter publishes input_cache_read ${liveCacheRead} but supportsCaching is false`,
          );
        }
      }

      if (rateDrifts.length > 0) {
        console.warn(
          `OpenRouter rate drift (non-blocking):\n${rateDrifts.join("\n")}`,
        );
      }
      expect(blocking, blocking.join("\n")).toEqual([]);
    },
    LIVE_FETCH_TIMEOUT_MS + 5_000,
  );
});
