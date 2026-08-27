/**
 * Guards over the `memory.retrospective` switches that decide whether the
 * retrospective pass runs at all.
 *
 * The defaults are the contract: a workspace that says nothing must leave
 * retrospectives on. A leftover `forkStrategy` key is ignored; retrospective
 * forks are always referential.
 */

import { describe, expect, test } from "bun:test";

import { MemoryRetrospectiveConfigSchema } from "../schemas/memory-retrospective.js";

describe("memory.retrospective config schema", () => {
  test("an empty block leaves retrospectives on", () => {
    const parsed = MemoryRetrospectiveConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed).not.toHaveProperty("forkStrategy");
  });

  test("enabled is a boolean-only kill switch", () => {
    expect(
      MemoryRetrospectiveConfigSchema.parse({ enabled: false }).enabled,
    ).toBe(false);
    expect(
      MemoryRetrospectiveConfigSchema.safeParse({ enabled: "false" }).success,
    ).toBe(false);
  });

  test("a leftover forkStrategy key is ignored", () => {
    const parsed = MemoryRetrospectiveConfigSchema.parse({
      forkStrategy: "cloning",
    });
    expect(parsed).not.toHaveProperty("forkStrategy");
    expect(parsed.enabled).toBe(true);
  });
});
