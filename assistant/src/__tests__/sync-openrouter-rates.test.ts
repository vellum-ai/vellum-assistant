/**
 * Unit cover for `scripts/sync-openrouter-rates.ts`.
 *
 * These tests are hermetic: nothing here reaches the network. The live
 * comparison against OpenRouter's card belongs to the scheduled workflow, so
 * what is covered here is the part that is ours to get right, namely the
 * conversion arithmetic and the source rewriting.
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

/** Source of the `openrouter` provider entry, bounded by the next provider. */
function openrouterBlock(source: string): string {
  const start = source.search(/^\s*id: "openrouter",$/m);
  const rest = source.slice(start + 1);
  const next = rest.search(/^\s{4}id: "[^"]+",$/m);
  return next === -1
    ? source.slice(start)
    : source.slice(start, start + 1 + next);
}

/** Source of one model's object inside the openrouter block. */
function modelEntry(block: string, modelId: string): string {
  const at = block.indexOf(`id: "${modelId}",`);
  return block.slice(at, block.indexOf("\n      },", at));
}

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

  test("a rate spelled with a trailing .0 rewrites to a whole literal", () => {
    // `2.0` parses to `2`, so a matcher built from the parsed number would
    // replace only the leading digit and strand the `.0`.
    const block = openrouterBlock(source);
    const spelledWithDotZero = openrouterModels().find(
      (model) =>
        !model.pricing?.tiers?.length &&
        model.pricing?.outputPer1mTokens !== undefined &&
        // Scoped to this model's own entry: the same literal spelled `.0` on
        // an unrelated model would otherwise satisfy a whole-file search.
        modelEntry(block, model.id).includes(
          `outputPer1mTokens: ${model.pricing.outputPer1mTokens}.0,`,
        ),
    );
    expect(
      spelledWithDotZero,
      "the openrouter block needs a plain model whose rate is spelled with a trailing .0",
    ).toBeDefined();

    const live = liveCardMatchingCatalog();
    const moved = spelledWithDotZero!.pricing!.outputPer1mTokens + 0.5;
    live.set(spelledWithDotZero!.id, {
      id: spelledWithDotZero!.id,
      pricing: {
        ...live.get(spelledWithDotZero!.id)!.pricing,
        completion: String(moved / 1_000_000),
      },
    });

    const plan = planSync(source, live);

    expect(plan.changes).toHaveLength(1);
    expect(plan.source).toContain(`outputPer1mTokens: ${formatRate(moved)},`);
    // The stranded-suffix shape, e.g. `2.5.0`, must not appear anywhere.
    expect(plan.source).not.toMatch(/Per1mTokens: [0-9]+\.[0-9]+\.[0-9]+/);
    expect(plan.source.includes(`${formatRate(moved)}.0`)).toBe(false);
  });

  test("a tiered model reports its base move instead of applying it", () => {
    // Tier rates are scaled from the base rather than published, so moving a
    // base alone would price the model inconsistently above its threshold.
    const tiered = openrouterModels().find(
      (model) =>
        model.pricing?.tiers?.length &&
        model.pricing.inputPer1mTokens !== undefined,
    );
    expect(tiered, "the openrouter block needs a tiered model").toBeDefined();

    const live = liveCardMatchingCatalog();
    const moved = tiered!.pricing!.inputPer1mTokens * 2;
    live.set(tiered!.id, {
      id: tiered!.id,
      pricing: {
        ...live.get(tiered!.id)!.pricing,
        prompt: String(moved / 1_000_000),
      },
    });

    const plan = planSync(source, live);

    expect(plan.changes).toEqual([]);
    expect(plan.source).toBe(source);
    expect(plan.findings.map((f) => f.modelId)).toContain(tiered!.id);
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
