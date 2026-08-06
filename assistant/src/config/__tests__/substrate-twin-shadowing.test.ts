import { describe, expect, test } from "bun:test";

import { MemorySubstrateConfigSchema } from "../schemas/memory-substrate.js";
import { MemoryV2ConfigSchema } from "../schemas/memory-v2.js";
import {
  describeShadowedConfigGet,
  describeShadowedConfigSet,
  findSubstrateShadowing,
  SUBSTRATE_TWIN_BY_V2_KEY,
} from "../substrate-twin-shadowing.js";

describe("substrate twin table", () => {
  test("pairs exactly the memory.substrate schema's keys", () => {
    // Drift guard: a substrate key with no entry here is a tunable whose
    // shadowing goes unreported, which is the silent no-op this module exists
    // to prevent.
    expect(
      new Set(
        Object.values(SUBSTRATE_TWIN_BY_V2_KEY).map((t) => t.substrateKey),
      ),
    ).toEqual(new Set(Object.keys(MemorySubstrateConfigSchema.shape)));
  });

  test("names a real memory.v2 key on every left-hand side", () => {
    const v2Keys = new Set(Object.keys(MemoryV2ConfigSchema.shape));
    for (const v2Key of Object.keys(SUBSTRATE_TWIN_BY_V2_KEY)) {
      expect(v2Keys).toContain(v2Key);
    }
  });

  test("flags exactly the three twins the v2 injection engine reads directly", () => {
    // `v2/injection.ts` destructures `k` / `hops` off `config.memory.v2` (as
    // does `v2/backfill-jobs.ts`) and `v2/activation.ts` reads
    // `config.memory.v2.ann_candidate_limit`. Every other twin's only reader
    // is `resolveSubstrateTuning`. Widening this set without a matching
    // direct read makes the warnings claim a divergence that cannot happen.
    const engineRead = Object.entries(SUBSTRATE_TWIN_BY_V2_KEY)
      .filter(([, twin]) => twin.alsoReadByV2Engine)
      .map(([v2Key]) => v2Key)
      .sort();
    expect(engineRead).toEqual(["ann_candidate_limit", "hops", "k"]);
  });
});

describe("findSubstrateShadowing", () => {
  test("reports the winning substrate twin for a shadowed memory.v2 key", () => {
    const raw = {
      memory: {
        v2: { consolidation_interval_hours: 4 },
        substrate: { consolidation_interval_hours: 876000 },
      },
    };

    expect(
      findSubstrateShadowing(raw, "memory.v2.consolidation_interval_hours"),
    ).toEqual({
      substratePath: "memory.substrate.consolidation_interval_hours",
      substrateValue: 876000,
      alsoReadByV2Engine: false,
    });
  });

  test("maps the renamed spread keys to their substrate names", () => {
    const raw = { memory: { v2: {}, substrate: { spread_k: 0.4 } } };

    expect(findSubstrateShadowing(raw, "memory.v2.k")).toEqual({
      substratePath: "memory.substrate.spread_k",
      substrateValue: 0.4,
      alsoReadByV2Engine: true,
    });
    // hops has no twin set, so nothing shadows it.
    expect(findSubstrateShadowing(raw, "memory.v2.hops")).toBeUndefined();
  });

  test("treats an explicit null twin as set, matching resolveSubstrateTuning", () => {
    // `orV2` falls back only on `undefined`, so a null substrate value wins —
    // and it is exactly the value the consolidation freeze writes.
    const raw = {
      memory: {
        v2: { consolidation_max_buffer_lines: 100 },
        substrate: { consolidation_max_buffer_lines: null },
      },
    };

    expect(
      findSubstrateShadowing(raw, "memory.v2.consolidation_max_buffer_lines"),
    ).toEqual({
      substratePath: "memory.substrate.consolidation_max_buffer_lines",
      substrateValue: null,
      alsoReadByV2Engine: false,
    });
  });

  test("returns nothing for unshadowed paths", () => {
    const raw = {
      memory: {
        v2: { bm25_b: 0.6, enabled: true },
        substrate: { bm25_b: 0.3 },
      },
    };

    // No memory.substrate subtree at all.
    expect(
      findSubstrateShadowing(
        { memory: { v2: { bm25_b: 0.6 } } },
        "memory.v2.bm25_b",
      ),
    ).toBeUndefined();
    // A v2 key with no substrate twin.
    expect(findSubstrateShadowing(raw, "memory.v2.enabled")).toBeUndefined();
    // The substrate key itself is what wins — writing it is never shadowed.
    expect(
      findSubstrateShadowing(raw, "memory.substrate.bm25_b"),
    ).toBeUndefined();
    // Paths outside the memory namespace, and the wrong depth.
    expect(findSubstrateShadowing(raw, "memory.v2")).toBeUndefined();
    expect(findSubstrateShadowing(raw, "llm.v2.bm25_b")).toBeUndefined();
  });
});

describe("describeShadowedConfigSet", () => {
  test("a substrate-only twin reads as the no-op it is", () => {
    const message = describeShadowedConfigSet(
      {
        substratePath: "memory.substrate.consolidation_interval_hours",
        substrateValue: 876000,
        alsoReadByV2Engine: false,
      },
      "memory.v2.consolidation_interval_hours",
    );

    expect(message).toContain(
      "memory.substrate.consolidation_interval_hours is set (876000)",
    );
    expect(message).toContain("does not change the effective value");
    expect(message).toContain(
      "assistant config set memory.substrate.consolidation_interval_hours",
    );
  });

  test("an engine-read twin reports divergence, never inertness", () => {
    // `memory.v2.k` still tunes the live v2 injection engine, so claiming the
    // write is inert would send an operator chasing a phantom.
    const message = describeShadowedConfigSet(
      {
        substratePath: "memory.substrate.spread_k",
        substrateValue: 0.4,
        alsoReadByV2Engine: true,
      },
      "memory.v2.k",
    );

    expect(message).toContain("does change its behavior");
    expect(message).toContain("memory.substrate.spread_k (0.4)");
    expect(message).toContain("diverge");
    expect(message).not.toContain("does not change the effective value");
  });
});

describe("describeShadowedConfigGet", () => {
  test("a substrate-only twin names the key that is the effective value", () => {
    const message = describeShadowedConfigGet(
      {
        substratePath: "memory.substrate.bm25_b",
        substrateValue: 0.3,
        alsoReadByV2Engine: false,
      },
      "memory.v2.bm25_b",
    );

    expect(message).toContain("Shadowed: memory.substrate.bm25_b = 0.3");
    expect(message).toContain("is the effective value");
  });

  test("an engine-read twin names both readers", () => {
    const message = describeShadowedConfigGet(
      {
        substratePath: "memory.substrate.ann_candidate_limit",
        substrateValue: null,
        alsoReadByV2Engine: true,
      },
      "memory.v2.ann_candidate_limit",
    );

    expect(message).toContain(
      "Split: memory.substrate.ann_candidate_limit = null",
    );
    expect(message).toContain("substrate recall");
    expect(message).toContain("memory.v2.ann_candidate_limit");
  });
});
