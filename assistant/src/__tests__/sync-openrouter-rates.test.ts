/**
 * Unit cover for `scripts/sync-openrouter-rates.ts`, the job that follows
 * OpenRouter's published rates into the catalog.
 *
 * These tests are hermetic on purpose. The live comparison they replaced ran
 * inside `bun run test` and failed the build for whoever pushed next whenever
 * OpenRouter repriced, which happened three times in twelve hours. The live
 * fetch now runs on a schedule and opens a PR; what stays here is the part
 * that is genuinely ours to get right, namely the conversion arithmetic and
 * the source rewriting.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  formatRate,
  perMillionFromOpenRouterPrice,
  planSync,
  rateDiffers,
} from "../../scripts/sync-openrouter-rates.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";

const CATALOG_PATH = join(process.cwd(), "src/providers/model-catalog.ts");

function openrouterModels() {
  const entry = PROVIDER_CATALOG.find(
    (provider) => provider.id === "openrouter",
  );
  if (!entry) {
    throw new Error("PROVIDER_CATALOG is missing the openrouter entry");
  }
  return entry.models;
}

/** A live card that agrees with the catalog exactly, as the baseline. */
function liveCardMatchingCatalog() {
  const perToken = (per1m: number | undefined) =>
    per1m === undefined ? undefined : String(per1m / 1_000_000);
  return new Map(
    openrouterModels().map((model) => [
      model.id,
      {
        id: model.id,
        pricing: {
          prompt: perToken(model.pricing?.inputPer1mTokens),
          completion: perToken(model.pricing?.outputPer1mTokens),
          input_cache_read: perToken(model.pricing?.cacheReadPer1mTokens),
          input_cache_write: perToken(model.pricing?.cacheWritePer1mTokens),
        },
      },
    ]),
  );
}

describe("OpenRouter price conversion", () => {
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

  test("formatRate drops multiply artifacts past the 12th digit", () => {
    // 0.0000000177212 per token comes back as 0.017721200000000003 per 1M.
    expect(formatRate(0.0000000177212 * 1_000_000)).toBe("0.0177212");
    expect(formatRate(1.19)).toBe("1.19");
    expect(formatRate(0.790308)).toBe("0.790308");
  });
});

describe("planSync", () => {
  const source = readFileSync(CATALOG_PATH, "utf-8");

  test("a live card matching the catalog produces no edit", () => {
    const plan = planSync(source, liveCardMatchingCatalog());
    expect(plan.changes).toEqual([]);
    expect(plan.source).toBe(source);
  });

  test("a moved rate rewrites exactly that one literal", () => {
    const live = liveCardMatchingCatalog();
    const target = openrouterModels().find(
      (model) => model.pricing?.inputPer1mTokens !== undefined,
    );
    expect(target).toBeDefined();
    const moved = target!.pricing!.inputPer1mTokens * 2;
    live.set(target!.id, {
      id: target!.id,
      pricing: {
        ...live.get(target!.id)!.pricing,
        prompt: String(moved / 1_000_000),
      },
    });

    const plan = planSync(source, live);

    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      modelId: target!.id,
      field: "inputPer1mTokens",
      to: moved,
    });
    expect(plan.source).not.toBe(source);
    expect(plan.source).toContain(`inputPer1mTokens: ${formatRate(moved)},`);
  });

  test("a rate shared with another provider block only moves inside openrouter", () => {
    // `deepseek/deepseek-v4-flash` appears in both the openrouter and the
    // vercel-ai-gateway blocks at different rates. Rewriting by model id alone
    // would corrupt the second one, so the rewrite is bounded to the
    // openrouter provider entry.
    const sharedId = "deepseek/deepseek-v4-flash";
    const inOpenrouter = openrouterModels().find((m) => m.id === sharedId);
    expect(
      inOpenrouter,
      `${sharedId} is the cross-block fixture for this test`,
    ).toBeDefined();

    const gateway = PROVIDER_CATALOG.find((p) => p.id === "vercel-ai-gateway");
    const gatewayCopy = gateway?.models.find((m) => m.id === sharedId);
    expect(
      gatewayCopy?.pricing?.inputPer1mTokens,
      `${sharedId} must still exist in vercel-ai-gateway at its own rate`,
    ).toBeDefined();
    expect(gatewayCopy!.pricing!.inputPer1mTokens).not.toBe(
      inOpenrouter!.pricing!.inputPer1mTokens,
    );

    const live = liveCardMatchingCatalog();
    const moved = inOpenrouter!.pricing!.inputPer1mTokens * 3;
    live.set(sharedId, {
      id: sharedId,
      pricing: {
        ...live.get(sharedId)!.pricing,
        prompt: String(moved / 1_000_000),
      },
    });

    const plan = planSync(source, live);

    expect(plan.changes).toHaveLength(1);
    // The gateway literal survives verbatim, and the file still carries
    // exactly one copy of it.
    const gatewayLiteral = `inputPer1mTokens: ${gatewayCopy!.pricing!.inputPer1mTokens},`;
    const before = source.split(gatewayLiteral).length - 1;
    const after = plan.source.split(gatewayLiteral).length - 1;
    expect(after).toBe(before);
  });

  test("an id the live card no longer serves is reported, never deleted", () => {
    const live = liveCardMatchingCatalog();
    const dropped = openrouterModels()[0]!;
    live.delete(dropped.id);

    const plan = planSync(source, live);

    expect(plan.changes).toEqual([]);
    expect(plan.source).toBe(source);
    expect(plan.findings.map((f) => f.modelId)).toContain(dropped.id);
  });
});
