import { describe, expect, test } from "bun:test";

import { AUTO_ANALYSIS_SOURCE } from "../../../../persistence/auto-analysis-constants.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../../../../persistence/conversation-types.js";
import {
  MEMORY_RETROSPECTIVE_FORK_SOURCE,
  MEMORY_RETROSPECTIVE_SOURCE,
} from "../memory-retrospective-constants.js";
import {
  classifyRetrospectiveEligibility,
  type MemoryCaptureGuidance,
  renderMemoryCaptureGuidance,
  resolveMemoryCaptureGuidance,
  type RetrospectiveEligibilityInput,
} from "../memory-retrospective-eligibility.js";

const ON: Pick<
  RetrospectiveEligibilityInput,
  "memoryEnabled" | "retrospectiveEnabled"
> = { memoryEnabled: true, retrospectiveEnabled: true };

describe("classifyRetrospectiveEligibility", () => {
  test.each([
    ["standard", "user"],
    ["standard", "cli"],
    ["background", "user"],
    ["background", "heartbeat"],
  ])("%s / %s is conditional", (conversationType, source) => {
    expect(
      classifyRetrospectiveEligibility({ ...ON, conversationType, source }),
    ).toEqual({ status: "conditional" });
  });

  test("scheduled is the only excluded conversation type", () => {
    expect(
      classifyRetrospectiveEligibility({
        ...ON,
        conversationType: "scheduled",
        source: "user",
      }),
    ).toEqual({ status: "ineligible", reason: "scheduled" });
  });

  test.each([
    [MEMORY_RETROSPECTIVE_SOURCE, "retrospective_conversation"],
    [MEMORY_RETROSPECTIVE_FORK_SOURCE, "retrospective_conversation"],
    [MEMORY_V2_CONSOLIDATION_SOURCE, "consolidation"],
    [AUTO_ANALYSIS_SOURCE, "auto_analysis"],
  ] as const)("source %s is ineligible as %s", (source, reason) => {
    expect(
      classifyRetrospectiveEligibility({
        ...ON,
        conversationType: "background",
        source,
      }),
    ).toEqual({ status: "ineligible", reason });
  });

  test("memory_disabled outranks every other reason", () => {
    expect(
      classifyRetrospectiveEligibility({
        conversationType: "scheduled",
        source: MEMORY_V2_CONSOLIDATION_SOURCE,
        memoryEnabled: false,
        retrospectiveEnabled: false,
      }),
    ).toEqual({ status: "ineligible", reason: "memory_disabled" });
  });

  test("retrospective_disabled outranks the type and source reasons", () => {
    expect(
      classifyRetrospectiveEligibility({
        conversationType: "scheduled",
        source: MEMORY_RETROSPECTIVE_SOURCE,
        memoryEnabled: true,
        retrospectiveEnabled: false,
      }),
    ).toEqual({ status: "ineligible", reason: "retrospective_disabled" });
  });
});

describe("resolveMemoryCaptureGuidance", () => {
  test("a guardian turn with memory on can write", () => {
    const guidance = resolveMemoryCaptureGuidance({
      ...ON,
      conversationType: "standard",
      source: "user",
      trustClass: "guardian",
    });
    expect(guidance).toEqual({
      laterPass: { status: "conditional" },
      canWriteMemory: true,
    });
  });

  test.each(["trusted_contact", "unverified_contact", "unknown", undefined])(
    "a %s turn cannot write even with memory on",
    (trustClass) => {
      const guidance = resolveMemoryCaptureGuidance({
        ...ON,
        conversationType: "standard",
        source: "user",
        trustClass,
      });
      expect(guidance.canWriteMemory).toBe(false);
      // Eligibility is a property of the conversation, not the actor.
      expect(guidance.laterPass).toEqual({ status: "conditional" });
    },
  );

  test("a guardian turn with memory off cannot write", () => {
    const guidance = resolveMemoryCaptureGuidance({
      conversationType: "standard",
      source: "user",
      memoryEnabled: false,
      retrospectiveEnabled: true,
      trustClass: "guardian",
    });
    expect(guidance).toEqual({
      laterPass: { status: "ineligible", reason: "memory_disabled" },
      canWriteMemory: false,
    });
  });
});

describe("renderMemoryCaptureGuidance", () => {
  const conditional: MemoryCaptureGuidance["laterPass"] = {
    status: "conditional",
  };
  const scheduled: MemoryCaptureGuidance["laterPass"] = {
    status: "ineligible",
    reason: "scheduled",
  };

  test("can write, no later pass: save with remember now", () => {
    const line = renderMemoryCaptureGuidance({
      laterPass: scheduled,
      canWriteMemory: true,
    });
    expect(line).toContain("No later memory pass reviews this conversation");
    expect(line).toContain("`remember` now");
  });

  test("can write, conditional: not guaranteed, still save with remember now", () => {
    const line = renderMemoryCaptureGuidance({
      laterPass: conditional,
      canWriteMemory: true,
    });
    expect(line).toContain(
      "may review this conversation but is not guaranteed",
    );
    expect(line).toContain("`remember` now");
  });

  test.each([
    [
      "memory off",
      { status: "ineligible", reason: "memory_disabled" } as const,
      "Memory is off for this assistant",
    ],
    [
      "no capability, no later pass",
      scheduled,
      "You cannot save memory on this turn, and no later memory pass",
    ],
    [
      "no capability, conditional",
      conditional,
      "You cannot save memory on this turn. A later memory pass may review",
    ],
  ])("cannot write (%s): names no tool", (_label, laterPass, expected) => {
    const line = renderMemoryCaptureGuidance({
      laterPass,
      canWriteMemory: false,
    });
    expect(line).toContain(expected);
    expect(line).not.toContain("remember");
  });
});
