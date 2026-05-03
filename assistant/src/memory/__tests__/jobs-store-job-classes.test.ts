import { describe, expect, test } from "bun:test";

import { EMBED_JOB_TYPES, SLOW_LLM_JOB_TYPES } from "../jobs-store.js";

describe("memory job classes", () => {
  test("EMBED_JOB_TYPES and SLOW_LLM_JOB_TYPES are disjoint", () => {
    const embedSet = new Set<string>(EMBED_JOB_TYPES);
    const overlap = SLOW_LLM_JOB_TYPES.filter((t) => embedSet.has(t));
    expect(overlap).toEqual([]);
  });

  test("SLOW_LLM_JOB_TYPES entries are non-empty strings", () => {
    expect(SLOW_LLM_JOB_TYPES.length).toBeGreaterThan(0);
    for (const t of SLOW_LLM_JOB_TYPES) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(0);
    }
  });

  test("SLOW_LLM_JOB_TYPES has no duplicate entries", () => {
    const set = new Set(SLOW_LLM_JOB_TYPES);
    expect(set.size).toBe(SLOW_LLM_JOB_TYPES.length);
  });
});
