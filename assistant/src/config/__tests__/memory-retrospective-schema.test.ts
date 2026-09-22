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
  test("an empty block leaves skill improvement on and monitoring off", () => {
    const parsed = MemoryRetrospectiveConfigSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.skillImprovement).toBe(true);
    expect(parsed.skillImprovementMonitoring).toBe(false);
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

  test("skillImprovement is an independent boolean-only authoring switch", () => {
    const parsed = MemoryRetrospectiveConfigSchema.parse({
      skillImprovement: false,
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.skillImprovement).toBe(false);
    expect(
      MemoryRetrospectiveConfigSchema.safeParse({
        skillImprovement: "false",
      }).success,
    ).toBe(false);
  });

  test("skillImprovementMonitoring is a boolean-only opt-in", () => {
    const parsed = MemoryRetrospectiveConfigSchema.parse({
      skillImprovementMonitoring: true,
    });
    expect(parsed.skillImprovementMonitoring).toBe(true);
    expect(
      MemoryRetrospectiveConfigSchema.safeParse({
        skillImprovementMonitoring: "true",
      }).success,
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
