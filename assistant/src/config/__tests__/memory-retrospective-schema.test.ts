/**
 * Guards over the `memory.retrospective` switches that decide whether the
 * retrospective pass runs at all, and how its fork is materialized.
 *
 * The defaults are the contract: a workspace that says nothing must behave
 * exactly as it did before the fields existed: retrospectives on, forks
 * cloned.
 */

import { describe, expect, test } from "bun:test";

import { MemoryRetrospectiveConfigSchema } from "../schemas/memory-retrospective.js";

describe("memory.retrospective config schema", () => {
  test("an empty block leaves retrospectives on and forks cloning", () => {
    const parsed = MemoryRetrospectiveConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.forkStrategy).toBe("cloning");
  });

  test("enabled is a boolean-only kill switch", () => {
    expect(
      MemoryRetrospectiveConfigSchema.parse({ enabled: false }).enabled,
    ).toBe(false);
    expect(
      MemoryRetrospectiveConfigSchema.safeParse({ enabled: "false" }).success,
    ).toBe(false);
  });

  test("forkStrategy accepts only cloning and reference", () => {
    expect(
      MemoryRetrospectiveConfigSchema.parse({ forkStrategy: "reference" })
        .forkStrategy,
    ).toBe("reference");
    expect(
      MemoryRetrospectiveConfigSchema.safeParse({ forkStrategy: "referential" })
        .success,
    ).toBe(false);
  });
});
