import { describe, expect, test } from "bun:test";

import { MemoryConfigSchema } from "../memory.js";
import { MemoryV2ConfigSchema, MemoryV3ConfigSchema } from "../memory-v2.js";

describe("MemoryV2ConfigSchema", () => {
  test("parses an empty object to documented defaults", () => {
    const parsed = MemoryV2ConfigSchema.parse({});
    expect(parsed).toEqual({
      enabled: true,
      sweep_enabled: false,
      d: 0.3,
      c_user: 0.3,
      c_assistant: 0.2,
      c_now: 0.2,
      k: 0.5,
      hops: 2,
      top_k: 25,
      ann_candidate_limit: null,
      epsilon: 0.01,
      dense_weight: 0.85,
      sparse_weight: 0.15,
      bm25_k1: 1.2,
      bm25_b: 0.4,
      consolidation_interval_hours: 4,
      consolidation_max_buffer_lines: 100,
      max_page_chars: 5000,
      consolidation_prompt_path: null,
      rerank: {
        enabled: false,
        top_k: 50,
        alpha: 0.3,
        model: "Alibaba-NLP/gte-reranker-modernbert-base",
        dtype: "q8",
      },
      router: {
        enabled: true,
        max_page_ids: 25,
        router_prompt_path: null,
        batch_size: null,
        tier1_size: null,
        tier2_size: null,
        historical_pairs: 1,
        historical_pairs_max_chars: null,
      },
    });
  });

  test("defaults satisfy both weight-sum constraints", () => {
    const parsed = MemoryV2ConfigSchema.parse({});
    expect(parsed.d + parsed.c_user + parsed.c_assistant + parsed.c_now).toBe(
      1,
    );
    expect(parsed.dense_weight + parsed.sparse_weight).toBe(1);
  });

  test("accepts an explicit override that still sums to 1.0", () => {
    const parsed = MemoryV2ConfigSchema.parse({
      d: 0.4,
      c_user: 0.3,
      c_assistant: 0.2,
      c_now: 0.1,
    });
    expect(parsed.d).toBe(0.4);
    expect(parsed.c_user).toBe(0.3);
    expect(parsed.c_assistant).toBe(0.2);
    expect(parsed.c_now).toBe(0.1);
  });

  test("accepts hybrid weights that still sum to 1.0", () => {
    const parsed = MemoryV2ConfigSchema.parse({
      dense_weight: 0.5,
      sparse_weight: 0.5,
    });
    expect(parsed.dense_weight).toBe(0.5);
    expect(parsed.sparse_weight).toBe(0.5);
  });

  test("rejects activation weights that do not sum to 1.0", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({
        d: 0.5,
        c_user: 0.5,
        c_assistant: 0.5,
        c_now: 0.5,
      }),
    ).toThrow(/activation weights/);
  });

  test("rejects activation weights that sum to less than 1.0", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({
        d: 0.1,
        c_user: 0.1,
        c_assistant: 0.1,
        c_now: 0.1,
      }),
    ).toThrow(/activation weights/);
  });

  test("rejects hybrid weights that do not sum to 1.0", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({
        dense_weight: 0.8,
        sparse_weight: 0.5,
      }),
    ).toThrow(/hybrid weights/);
  });

  test("allows weight sums within the 0.001 tolerance and rejects beyond it", () => {
    // Just inside the tolerance (gap ~0.0005) — accepted.
    const ok = MemoryV2ConfigSchema.parse({
      d: 0.3005,
      c_user: 0.3,
      c_assistant: 0.2,
      c_now: 0.2,
    });
    expect(ok.d).toBe(0.3005);

    // Beyond the tolerance (gap = 0.005) — rejected.
    expect(() =>
      MemoryV2ConfigSchema.parse({
        d: 0.305,
        c_user: 0.3,
        c_assistant: 0.2,
        c_now: 0.2,
      }),
    ).toThrow(/activation weights/);
  });

  test("rejects negative weight values", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({
        d: -0.1,
        c_user: 0.4,
        c_assistant: 0.4,
        c_now: 0.3,
      }),
    ).toThrow();
  });

  test("rejects non-integer hops", () => {
    expect(() => MemoryV2ConfigSchema.parse({ hops: 1.5 })).toThrow();
  });

  test("rejects zero or negative top_k", () => {
    expect(() => MemoryV2ConfigSchema.parse({ top_k: 0 })).toThrow();
    expect(() => MemoryV2ConfigSchema.parse({ top_k: -5 })).toThrow();
  });

  test("rejects zero or negative consolidation_interval_hours", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({ consolidation_interval_hours: 0 }),
    ).toThrow();
  });

  test("rejects zero or negative max_page_chars", () => {
    expect(() => MemoryV2ConfigSchema.parse({ max_page_chars: 0 })).toThrow();
  });

  test("rejects non-boolean enabled", () => {
    expect(() => MemoryV2ConfigSchema.parse({ enabled: "yes" })).toThrow();
  });

  test("rejects epsilon outside [0, 1]", () => {
    expect(() => MemoryV2ConfigSchema.parse({ epsilon: -0.01 })).toThrow();
    expect(() => MemoryV2ConfigSchema.parse({ epsilon: 1.5 })).toThrow();
  });

  test("router defaults to enabled with max_page_ids=25", () => {
    const parsed = MemoryV2ConfigSchema.parse({});
    expect(parsed.router.enabled).toBe(true);
    expect(parsed.router.max_page_ids).toBe(25);
  });

  test("accepts explicit router overrides", () => {
    const parsed = MemoryV2ConfigSchema.parse({
      router: { enabled: true, max_page_ids: 50 },
    });
    expect(parsed.router.enabled).toBe(true);
    expect(parsed.router.max_page_ids).toBe(50);
  });

  test("rejects router.max_page_ids below 1", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({ router: { max_page_ids: 0 } }),
    ).toThrow();
  });

  test("rejects router.max_page_ids above 100", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({ router: { max_page_ids: 101 } }),
    ).toThrow();
  });

  test("router_prompt_path defaults to null", () => {
    const parsed = MemoryV2ConfigSchema.parse({});
    expect(parsed.router.router_prompt_path).toBeNull();
  });

  test("accepts an explicit router_prompt_path override", () => {
    const parsed = MemoryV2ConfigSchema.parse({
      router: { router_prompt_path: "~/prompts/router.md" },
    });
    expect(parsed.router.router_prompt_path).toBe("~/prompts/router.md");
  });

  test("rejects non-string router_prompt_path", () => {
    expect(() =>
      MemoryV2ConfigSchema.parse({ router: { router_prompt_path: 42 } }),
    ).toThrow();
  });
});

describe("MemoryV3ConfigSchema", () => {
  test("parses an empty object to documented defaults", () => {
    const parsed = MemoryV3ConfigSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      shadow: false,
      passCap: 3,
      breadthBudget: 6,
      maxDepth: 6,
      denseQuota: { activeDomain: 30, offDomain: 8 },
      hotLimit: 50,
      lanes: { hot: true, sparse: true, dense: true, tree: true, edges: true },
      ks: [5, 10, 25, 50],
      write: {
        enabled: false,
        consolidateIntervalMs: 3600000,
        coactivation: false,
      },
      prompts: {
        filter: { override: null, path: null },
        descent: { override: null, path: null },
        gate: { override: null, path: null },
      },
      gateCandidateSummaries: false,
    });
  });

  test("parses undefined to the same defaults (top-level .default)", () => {
    expect(MemoryV3ConfigSchema.parse(undefined)).toEqual(
      MemoryV3ConfigSchema.parse({}),
    );
  });

  test("defaults to disabled for backwards compatibility", () => {
    expect(MemoryV3ConfigSchema.parse({}).enabled).toBe(false);
    expect(MemoryV3ConfigSchema.parse({}).shadow).toBe(false);
  });

  test("accepts explicit scalar overrides", () => {
    const parsed = MemoryV3ConfigSchema.parse({
      enabled: true,
      shadow: true,
      passCap: 5,
      breadthBudget: 10,
      maxDepth: 8,
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.shadow).toBe(true);
    expect(parsed.passCap).toBe(5);
    expect(parsed.breadthBudget).toBe(10);
    expect(parsed.maxDepth).toBe(8);
  });

  test("accepts explicit denseQuota override", () => {
    const parsed = MemoryV3ConfigSchema.parse({
      denseQuota: { activeDomain: 50, offDomain: 12 },
    });
    expect(parsed.denseQuota).toEqual({ activeDomain: 50, offDomain: 12 });
  });

  test("accepts a partial lanes override and defaults the rest", () => {
    const parsed = MemoryV3ConfigSchema.parse({ lanes: { dense: false } });
    expect(parsed.lanes).toEqual({
      hot: true,
      sparse: true,
      dense: false,
      tree: true,
      edges: true,
    });
  });

  test("accepts an explicit ks override", () => {
    const parsed = MemoryV3ConfigSchema.parse({ ks: [1, 3, 7] });
    expect(parsed.ks).toEqual([1, 3, 7]);
  });

  test("rejects a non-boolean enabled", () => {
    expect(() => MemoryV3ConfigSchema.parse({ enabled: "yes" })).toThrow();
  });

  test("rejects a non-integer passCap", () => {
    expect(() => MemoryV3ConfigSchema.parse({ passCap: 2.5 })).toThrow();
  });

  test("rejects non-number ks entries", () => {
    expect(() => MemoryV3ConfigSchema.parse({ ks: ["a"] })).toThrow();
  });

  test("parses the write subtree to safe off defaults when omitted", () => {
    const parsed = MemoryV3ConfigSchema.parse({});
    expect(parsed.write).toEqual({
      enabled: false,
      consolidateIntervalMs: 3600000,
      coactivation: false,
    });
  });

  test("accepts a partial write override and defaults the rest", () => {
    const parsed = MemoryV3ConfigSchema.parse({ write: { enabled: true } });
    expect(parsed.write).toEqual({
      enabled: true,
      consolidateIntervalMs: 3600000,
      coactivation: false,
    });
  });

  test("rejects a non-integer write.consolidateIntervalMs", () => {
    expect(() =>
      MemoryV3ConfigSchema.parse({ write: { consolidateIntervalMs: 1.5 } }),
    ).toThrow();
  });

  test("rejects a non-positive write.consolidateIntervalMs", () => {
    // 0 or negative would make the scheduler's `now - lastRun >= interval`
    // check always true, flooding the queue with consolidation jobs.
    expect(() =>
      MemoryV3ConfigSchema.parse({ write: { consolidateIntervalMs: 0 } }),
    ).toThrow();
    expect(() =>
      MemoryV3ConfigSchema.parse({ write: { consolidateIntervalMs: -1000 } }),
    ).toThrow();
  });

  test("accepts a positive write.consolidateIntervalMs override", () => {
    const parsed = MemoryV3ConfigSchema.parse({
      write: { consolidateIntervalMs: 1800000 },
    });
    expect(parsed.write.consolidateIntervalMs).toBe(1800000);
  });

  test("parses the prompts subtree to null overrides when omitted", () => {
    const parsed = MemoryV3ConfigSchema.parse({});
    expect(parsed.prompts).toEqual({
      filter: { override: null, path: null },
      descent: { override: null, path: null },
      gate: { override: null, path: null },
    });
  });

  test("accepts a partial prompts override and defaults the rest", () => {
    const parsed = MemoryV3ConfigSchema.parse({
      prompts: { filter: { override: "custom filter prompt" } },
    });
    expect(parsed.prompts.filter).toEqual({
      override: "custom filter prompt",
      path: null,
    });
    // Lanes not mentioned keep their null defaults.
    expect(parsed.prompts.descent).toEqual({ override: null, path: null });
    expect(parsed.prompts.gate).toEqual({ override: null, path: null });
  });

  test("accepts a file path override for a prompt lane", () => {
    const parsed = MemoryV3ConfigSchema.parse({
      prompts: { gate: { path: "~/prompts/v3-gate.md" } },
    });
    expect(parsed.prompts.gate).toEqual({
      override: null,
      path: "~/prompts/v3-gate.md",
    });
  });

  test("rejects a non-string prompts override", () => {
    expect(() =>
      MemoryV3ConfigSchema.parse({ prompts: { filter: { override: 42 } } }),
    ).toThrow();
  });

  test("rejects a non-string prompts path", () => {
    expect(() =>
      MemoryV3ConfigSchema.parse({ prompts: { descent: { path: 7 } } }),
    ).toThrow();
  });
});

describe("MemoryConfigSchema integration with v3 block", () => {
  test("includes a v3 block defaulting to disabled when v3 is omitted", () => {
    const parsed = MemoryConfigSchema.parse({});
    expect(parsed.v3).toBeDefined();
    expect(parsed.v3.enabled).toBe(false);
    expect(parsed.v3.shadow).toBe(false);
    expect(parsed.v3.passCap).toBe(3);
    expect(parsed.v3.lanes.dense).toBe(true);
    expect(parsed.v3.ks).toEqual([5, 10, 25, 50]);
    expect(parsed.v3.write).toEqual({
      enabled: false,
      consolidateIntervalMs: 3600000,
      coactivation: false,
    });
  });

  test("leaves pre-existing configs (no v3 key) otherwise unchanged", () => {
    // A config authored before v3 existed parses fine and its v2 block is
    // untouched; the v3 block is purely additive.
    const parsed = MemoryConfigSchema.parse({ v2: { top_k: 50 } });
    expect(parsed.v2.top_k).toBe(50);
    expect(parsed.v3.enabled).toBe(false);
  });

  test("propagates v3 overrides through MemoryConfigSchema", () => {
    const parsed = MemoryConfigSchema.parse({
      v3: { enabled: true, passCap: 4 },
    });
    expect(parsed.v3.enabled).toBe(true);
    expect(parsed.v3.passCap).toBe(4);
    // Non-overridden v3 fields keep their defaults.
    expect(parsed.v3.maxDepth).toBe(6);
  });
});

describe("MemoryConfigSchema integration with v2 block", () => {
  test("parses an empty memory config and includes a v2 block with defaults", () => {
    const parsed = MemoryConfigSchema.parse({});
    expect(parsed.v2).toBeDefined();
    expect(parsed.v2.enabled).toBe(true);
    expect(parsed.v2.sweep_enabled).toBe(false);
    expect(parsed.v2.d).toBe(0.3);
    expect(parsed.v2.dense_weight).toBe(0.85);
    expect(parsed.v2.sparse_weight).toBe(0.15);
    expect(parsed.v2.consolidation_interval_hours).toBe(4);
    expect(parsed.v2.max_page_chars).toBe(5000);
  });

  test("propagates v2 overrides through MemoryConfigSchema", () => {
    const parsed = MemoryConfigSchema.parse({
      v2: { enabled: true, top_k: 50 },
    });
    expect(parsed.v2.enabled).toBe(true);
    expect(parsed.v2.top_k).toBe(50);
    // Non-overridden v2 fields keep their defaults.
    expect(parsed.v2.d).toBe(0.3);
  });

  test("rejects invalid v2 weights when nested in MemoryConfigSchema", () => {
    expect(() =>
      MemoryConfigSchema.parse({
        v2: {
          d: 0.5,
          c_user: 0.5,
          c_assistant: 0.5,
          c_now: 0.5,
        },
      }),
    ).toThrow(/activation weights/);
  });
});
