import { describe, expect, test } from "bun:test";

import { AUTO_ANALYSIS_SOURCE } from "../../../../persistence/auto-analysis-constants.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../../../../persistence/conversation-types.js";
import {
  MEMORY_RETROSPECTIVE_FORK_SOURCE,
  MEMORY_RETROSPECTIVE_SOURCE,
} from "../memory-retrospective-constants.js";
import {
  classifyRetrospectiveEligibility,
  isRetrospectiveTrustedActor,
  type MemoryCaptureGuidance,
  renderMemoryCaptureGuidance,
  resolveMemoryCaptureGuidance,
  type RetrospectiveEligibilityInput,
} from "../memory-retrospective-eligibility.js";

/** Switches on, guardian actor: the ordinary case every other test varies. */
const ON: Omit<RetrospectiveEligibilityInput, "conversationType" | "source"> = {
  memoryEnabled: true,
  retrospectiveEnabled: true,
  actorTrustClass: "guardian",
};

/** Every trust class that is not the guardian and not a legacy blank. */
const UNTRUSTED_CLASSES: string[] = [
  "trusted_contact",
  "unverified_contact",
  "unknown",
];

describe("isRetrospectiveTrustedActor", () => {
  test("the guardian is trusted", () => {
    expect(isRetrospectiveTrustedActor("guardian")).toBe(true);
  });

  test("legacy rows with no recorded provenance are trusted", () => {
    // Desktop-origin guardian threads never stamped provenance. Reading
    // `undefined` as untrusted would drop them from every trigger path.
    expect(isRetrospectiveTrustedActor(undefined)).toBe(true);
  });

  test.each(UNTRUSTED_CLASSES)("%s is not trusted", (trustClass) => {
    expect(isRetrospectiveTrustedActor(trustClass)).toBe(false);
  });
});

describe("classifyRetrospectiveEligibility", () => {
  test.each([
    ["standard", "user"],
    ["standard", "cli"],
    ["background", "user"],
    ["background", "heartbeat"],
  ])("%s / %s under a guardian actor is conditional", (type, source) => {
    expect(
      classifyRetrospectiveEligibility({
        ...ON,
        conversationType: type,
        source,
      }),
    ).toEqual({ status: "conditional" });
  });

  test("a legacy undefined actor is conditional, not excluded", () => {
    expect(
      classifyRetrospectiveEligibility({
        ...ON,
        conversationType: "standard",
        source: "user",
        actorTrustClass: undefined,
      }),
    ).toEqual({ status: "conditional" });
  });

  test.each(UNTRUSTED_CLASSES)("a %s actor is ineligible", (trustClass) => {
    expect(
      classifyRetrospectiveEligibility({
        ...ON,
        conversationType: "standard",
        source: "user",
        actorTrustClass: trustClass,
      }),
    ).toEqual({ status: "ineligible", reason: "untrusted_actor" });
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
        actorTrustClass: "unknown",
      }),
    ).toEqual({ status: "ineligible", reason: "memory_disabled" });
  });

  test("retrospective_disabled outranks the identity and actor reasons", () => {
    expect(
      classifyRetrospectiveEligibility({
        conversationType: "scheduled",
        source: MEMORY_RETROSPECTIVE_SOURCE,
        memoryEnabled: true,
        retrospectiveEnabled: false,
        actorTrustClass: "unknown",
      }),
    ).toEqual({ status: "ineligible", reason: "retrospective_disabled" });
  });

  test("a conversation reason outranks the turn-scoped actor reason", () => {
    // Both are true of a contact turn in a scheduled conversation. The
    // permanent fact about the conversation is the more useful one to report.
    expect(
      classifyRetrospectiveEligibility({
        ...ON,
        conversationType: "scheduled",
        source: "user",
        actorTrustClass: "trusted_contact",
      }),
    ).toEqual({ status: "ineligible", reason: "scheduled" });
  });
});

describe("resolveMemoryCaptureGuidance", () => {
  const STANDARD = { conversationType: "standard", source: "user" };

  test("a guardian turn with memory on and the tool present can write", () => {
    expect(
      resolveMemoryCaptureGuidance({
        ...ON,
        ...STANDARD,
        actorTrustClass: "guardian",
      }),
    ).toEqual({ laterPass: { status: "conditional" }, canWriteMemory: true });
  });

  test.each(UNTRUSTED_CLASSES)(
    "a %s turn cannot write and triggers no later pass",
    (trustClass) => {
      expect(
        resolveMemoryCaptureGuidance({
          ...ON,
          ...STANDARD,
          actorTrustClass: trustClass,
        }),
      ).toEqual({
        laterPass: { status: "ineligible", reason: "untrusted_actor" },
        canWriteMemory: false,
      });
    },
  );

  test("a guardian turn with memory off cannot write", () => {
    expect(
      resolveMemoryCaptureGuidance({
        ...ON,
        ...STANDARD,
        memoryEnabled: false,
        actorTrustClass: "guardian",
      }),
    ).toEqual({
      laterPass: { status: "ineligible", reason: "memory_disabled" },
      canWriteMemory: false,
    });
  });

  test("a guardian turn whose surface omits `remember` cannot write", () => {
    // Consolidation and the researcher and advisor subagent roles run
    // guardian-trust with allowlists that leave the tool out.
    expect(
      resolveMemoryCaptureGuidance({
        ...ON,
        ...STANDARD,
        actorTrustClass: "guardian",
        rememberToolAvailable: false,
      }),
    ).toEqual({ laterPass: { status: "conditional" }, canWriteMemory: false });
  });

  test("an omitted tool-surface answer makes no claim against the turn", () => {
    expect(
      resolveMemoryCaptureGuidance({
        ...ON,
        ...STANDARD,
        actorTrustClass: "guardian",
      }).canWriteMemory,
    ).toBe(true);
  });

  test("a legacy undefined actor keeps its conditional pass but cannot write", () => {
    // `resolveCapabilities(undefined)` reads as the `unknown` class, so the
    // write gate and the trigger gate genuinely disagree here. The copy has
    // to carry both halves.
    expect(
      resolveMemoryCaptureGuidance({
        ...ON,
        ...STANDARD,
        actorTrustClass: undefined,
      }),
    ).toEqual({ laterPass: { status: "conditional" }, canWriteMemory: false });
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
  const untrusted: MemoryCaptureGuidance["laterPass"] = {
    status: "ineligible",
    reason: "untrusted_actor",
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
      "untrusted actor",
      untrusted,
      "You cannot save memory on this turn, and this turn does not trigger a later memory pass.",
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

  test("the untrusted-actor copy is turn-scoped, not conversation-scoped", () => {
    // A conversation the guardian also speaks in stays reviewable, and that
    // review covers this turn's content, so the copy must not claim the
    // conversation is never reviewed.
    const line = renderMemoryCaptureGuidance({
      laterPass: untrusted,
      canWriteMemory: false,
    });
    expect(line).toContain("this turn does not trigger a later memory pass");
    expect(line).not.toContain("No later memory pass reviews");
  });
});
