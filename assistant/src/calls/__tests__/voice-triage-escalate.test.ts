import { afterEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { clearFeatureFlagOverridesCache } from "../../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../../config/schema.js";
import {
  capEscalationBridge,
  classifyFrontDoorLeading,
  ESCALATE_VERDICT_TOKEN,
  escalatedContinuationRule,
  ESCALATION_CONTINUATION_CONTENT,
  FALLBACK_ESCALATION_BRIDGE,
  FRONT_DOOR_PROFILE,
  frontDoorCapabilityDigest,
  frontDoorDecisionRule,
  HOLD_VERDICT_TOKEN,
  isEscalationBridgeComplete,
  isVoiceTriageEscalateEnabled,
  MAX_ESCALATION_BRIDGE_CHARS,
  needsFallbackBridge,
  spokenBridgeText,
  VOICE_TRIAGE_ESCALATE_FLAG,
} from "../voice-triage-escalate.js";

// The gate ignores the config arg (flags resolve from the override cache +
// bundled registry), so a bare cast is sufficient.
const CONFIG = {} as AssistantConfig;

afterEach(() => {
  clearFeatureFlagOverridesCache();
});

describe("voice-triage-escalate profiles", () => {
  test("front door is the fast Speed profile", () => {
    expect(FRONT_DOOR_PROFILE).toBe("cost-optimized");
  });
});

describe("frontDoorCapabilityDigest", () => {
  test("names the escalated leg's tools and demands escalation for them", () => {
    const digest = frontDoorCapabilityDigest(["calendar_read", "web_search"]);
    expect(digest).toContain("calendar_read, web_search");
    expect(digest.toLowerCase()).toContain("escalate");
    // The digest teaches routing, and the bridge phrase should name the
    // action rather than the model refusing or guessing.
    expect(digest.toLowerCase()).toContain("holding phrase");
  });

  test("is empty when no tool names are available (registry-less contexts)", () => {
    expect(frontDoorCapabilityDigest([])).toBe("");
  });

  test("appends to the decision rule only when non-empty", () => {
    const bare = frontDoorDecisionRule();
    expect(frontDoorDecisionRule({ capabilityDigest: "" })).toBe(bare);
    const withDigest = frontDoorDecisionRule({
      capabilityDigest: frontDoorCapabilityDigest(["calendar_read"]),
    });
    expect(withDigest.startsWith(bare)).toBe(true);
    expect(withDigest).toContain("calendar_read");
  });
});

describe("isVoiceTriageEscalateEnabled", () => {
  test("is off by default (registry defaultEnabled: false)", () => {
    clearFeatureFlagOverridesCache();
    expect(isVoiceTriageEscalateEnabled(CONFIG)).toBe(false);
  });

  test("is on when the flag override is set", () => {
    setOverridesForTesting({ [VOICE_TRIAGE_ESCALATE_FLAG]: true });
    expect(isVoiceTriageEscalateEnabled(CONFIG)).toBe(true);
  });

  test("is off when the flag override is explicitly false", () => {
    setOverridesForTesting({ [VOICE_TRIAGE_ESCALATE_FLAG]: false });
    expect(isVoiceTriageEscalateEnabled(CONFIG)).toBe(false);
  });
});

describe("front-door decision rule", () => {
  const rule = frontDoorDecisionRule();

  test("demands a leading verdict and teaches the escalate token", () => {
    expect(rule).toContain("DECIDE FIRST");
    expect(rule).toContain(ESCALATE_VERDICT_TOKEN);
    // The verdict must lead — never answer, then bail (spoken audio is final).
    expect(rule.toLowerCase()).toContain("must begin with your verdict");
    expect(rule.toLowerCase()).toContain("never start answering");
  });

  test("lists tool needs as an escalate trigger (no fabrication)", () => {
    expect(rule.toLowerCase()).toContain("tool");
  });

  test("demands a silent decision — no narrated reasoning in spoken output", () => {
    // Regression: a weak front-door model narrated its triage deliberation
    // aloud ("Context is complete — Alex paused...") before the bridge.
    expect(rule.toLowerCase()).toContain("chosen silently");
    expect(rule.toLowerCase()).toContain("never narrate");
  });

  test("bans verdict tokens anywhere but the leading position", () => {
    // Regression: a weak front-door model bled the bare hold digit into a
    // real answer ("hey 0"). Tokens are leading-verdict-only.
    expect(rule.toLowerCase()).toContain("never inside or after an answer");
  });

  test("includes the hold branch only when asked for", () => {
    expect(rule).not.toContain(HOLD_VERDICT_TOKEN);
    const withHold = frontDoorDecisionRule({ includeHold: true });
    expect(withHold).toContain(HOLD_VERDICT_TOKEN);
    // The tie-break asymmetry: when unsure whether the caller finished,
    // hold — infra failures fail open to a released turn instead.
    expect(withHold.toLowerCase()).toContain("when unsure");
  });

  test("demands a single-sentence holding phrase on escalation", () => {
    expect(rule.toLowerCase()).toContain("one short natural holding phrase");
    expect(rule.toLowerCase()).toContain("stop after that single sentence");
  });
});

describe("escalated continuation rule", () => {
  const rule = escalatedContinuationRule();

  test("tells the quality model to continue without re-greeting or repeating", () => {
    expect(rule.toLowerCase()).toContain("continue");
    expect(rule.toLowerCase()).toContain("do not greet again");
  });

  test("forbids the quality model from emitting verdict tokens", () => {
    expect(rule).toContain(ESCALATE_VERDICT_TOKEN);
    expect(rule.toLowerCase()).toContain("never output");
  });

  test("quotes the actual spoken bridge verbatim when provided", () => {
    const withBridge = escalatedContinuationRule("Let me check your calendar.");
    expect(withBridge).toContain('"Let me check your calendar."');
    expect(withBridge).not.toContain(FALLBACK_ESCALATION_BRIDGE);
  });

  test("quotes the canned fallback when no bridge (or a blank one) is provided", () => {
    expect(rule).toContain(`"${FALLBACK_ESCALATION_BRIDGE}"`);
    expect(escalatedContinuationRule("   ")).toContain(
      `"${FALLBACK_ESCALATION_BRIDGE}"`,
    );
  });

  test("bans re-announcing the holding phrase (bridge-echo regression)", () => {
    // Regression: after the bridge "Let me check your calendar", the quality
    // model opened with "Let me check what calendar connections…" — a
    // re-announcement echo. The rule must ban paraphrase/re-announce openers,
    // not just literal repetition.
    expect(rule.toLowerCase()).toContain("re-announce");
    expect(rule.toLowerCase()).toContain("paraphrase");
    expect(rule).toContain('"Let me check"');
  });
});

describe("capEscalationBridge", () => {
  test("cuts just after the first sentence terminator", () => {
    expect(
      capEscalationBridge(" Let me check your calendar. And also this junk"),
    ).toBe("Let me check your calendar.");
  });

  test("hard-caps a rambling bridge with no terminator", () => {
    const rambling = "a".repeat(MAX_ESCALATION_BRIDGE_CHARS + 50);
    expect(capEscalationBridge(rambling)).toHaveLength(
      MAX_ESCALATION_BRIDGE_CHARS,
    );
  });

  test("strips internal markers before capping", () => {
    expect(capEscalationBridge("[END_CALL] One moment.")).toBe("One moment.");
  });
});

describe("isEscalationBridgeComplete", () => {
  test("complete once a sentence terminator lands", () => {
    expect(isEscalationBridgeComplete(" Let me check")).toBe(false);
    expect(isEscalationBridgeComplete(" Let me check your calendar.")).toBe(
      true,
    );
  });

  test("complete at the hard cap even without a terminator", () => {
    expect(
      isEscalationBridgeComplete("a".repeat(MAX_ESCALATION_BRIDGE_CHARS)),
    ).toBe(true);
  });
});

describe("spokenBridgeText", () => {
  test("returns the capped bridge after a leading escalate verdict", () => {
    expect(
      spokenBridgeText(
        `${ESCALATE_VERDICT_TOKEN} Let me check your calendar. junk past the cap`,
      ),
    ).toBe("Let me check your calendar.");
  });

  test("is empty for a bare escalate verdict", () => {
    expect(spokenBridgeText(ESCALATE_VERDICT_TOKEN)).toBe("");
  });

  test("is empty when the output does not lead with the verdict (an answer)", () => {
    // A stray token later in an answer is not an escalation under the
    // verdict-first protocol.
    expect(spokenBridgeText("It is Tuesday.")).toBe("");
    expect(spokenBridgeText(`Half an answer ${ESCALATE_VERDICT_TOKEN}`)).toBe(
      "",
    );
  });
});

describe("needsFallbackBridge", () => {
  test("false when the model spoke a real holding phrase after the verdict", () => {
    expect(
      needsFallbackBridge(
        `${ESCALATE_VERDICT_TOKEN} Let me think about that for a second.`,
      ),
    ).toBe(false);
  });

  test("true for a bare escalate verdict with no holding phrase", () => {
    expect(needsFallbackBridge(ESCALATE_VERDICT_TOKEN)).toBe(true);
  });
});

describe("classifyFrontDoorLeading", () => {
  test("pending while the stream could still become a verdict token", () => {
    for (const leading of ["", "[", "[1"]) {
      expect(classifyFrontDoorLeading(leading, false)).toBe("pending");
    }
    expect(classifyFrontDoorLeading("[0", true)).toBe("pending");
  });

  test("hold on the leading hold token, but only when hold is enabled", () => {
    expect(classifyFrontDoorLeading("[0]", true)).toBe("hold");
    expect(classifyFrontDoorLeading("[0] trailing", true)).toBe("hold");
    // A leg whose prompt never taught the hold token must not have output
    // swallowed by it.
    expect(classifyFrontDoorLeading("[0]", false)).toBe("answer");
    expect(classifyFrontDoorLeading("[0", false)).toBe("answer");
  });

  test("escalate on the leading escalate token", () => {
    expect(classifyFrontDoorLeading("[1]", false)).toBe("escalate");
    expect(classifyFrontDoorLeading("[1] Let me check.", true)).toBe(
      "escalate",
    );
  });

  test("answer on anything else, including disproved bracket prefixes", () => {
    expect(classifyFrontDoorLeading("Sure, it's Tuesday.", true)).toBe(
      "answer",
    );
    // "[A…" can still be an ASK_GUARDIAN marker — the answer path's own
    // marker holdback owns that; classification only guards verdicts.
    expect(classifyFrontDoorLeading("[ASK_GUARDIAN: x]", true)).toBe("answer");
    expect(classifyFrontDoorLeading("[2]", true)).toBe("answer");
  });
});

describe("escalation continuation content", () => {
  test("is an echo-suppressed synthetic prompt (parenthesized, non-user-speech)", () => {
    expect(ESCALATION_CONTINUATION_CONTENT.startsWith("(")).toBe(true);
    expect(ESCALATION_CONTINUATION_CONTENT.endsWith(")")).toBe(true);
  });
});

// This module is the surface-agnostic escalation *policy* (profiles, prompt
// rules, the verdict classifier, the bridge cap/fallback decision, the flag
// gate). The two-leg *routing* runs on the in-app Voice Mode surface
// (LiveVoiceSession), gated behind both the voice-mode and
// voice-triage-escalate flags — see
// live-voice/__tests__/live-voice-triage-escalate.test.ts for the orchestration
// coverage (flag gating, verdict-first hand-off, token suppression, fallback
// bridge, barge-in). What remains for the manual cli-testing flow is true
// end-to-end audio: real TTS timing across the bridge, and the residual
// broadcast raw-token leak (issue #37850, shared by both voice surfaces) once
// that is addressed.
describe("live-voice escalation orchestration (end-to-end — TODO)", () => {
  test.todo(
    "an unpunctuated fallback bridge is force-flushed so the caller hears audio during the escalated model's call, not silence",
    () => {},
  );
  test.todo(
    "the escalated answer's TTS follows the bridge audio with no listening window between them",
    () => {},
  );
});
