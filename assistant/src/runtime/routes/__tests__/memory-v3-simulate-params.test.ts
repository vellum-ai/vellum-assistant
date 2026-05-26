/**
 * Schema tests for the `memory_v3_simulate` route request params.
 *
 * Focus: the `lanes` allowlist. Omitting it inherits the live lane toggles, but
 * an explicit empty array would force every lane off — a guaranteed no-op gate
 * LLM call — so it must be rejected at the schema. A non-empty allowlist and an
 * omitted `lanes` both parse.
 *
 * Pure schema test: no `mock.module`, so it is safe to run alongside others.
 */

import { describe, expect, test } from "bun:test";

import { MemoryV3SimulateParams } from "../memory-v3-routes.js";

describe("MemoryV3SimulateParams — lanes", () => {
  test("rejects an empty lanes array", () => {
    expect(() =>
      MemoryV3SimulateParams.parse({ query: "x", lanes: [] }),
    ).toThrow();
  });

  test("accepts a non-empty lanes allowlist", () => {
    const parsed = MemoryV3SimulateParams.parse({
      query: "x",
      lanes: ["tree", "edges"],
    });
    expect(parsed.lanes).toEqual(["tree", "edges"]);
  });

  test("accepts an omitted lanes (inherits live toggles)", () => {
    const parsed = MemoryV3SimulateParams.parse({ query: "x" });
    expect(parsed.lanes).toBeUndefined();
  });
});
