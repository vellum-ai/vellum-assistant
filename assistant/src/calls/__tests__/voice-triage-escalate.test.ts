import { afterEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { clearFeatureFlagOverridesCache } from "../../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../../config/schema.js";
import { ESCALATE_MARKER } from "../voice-control-protocol.js";
import {
  escalatedContinuationRule,
  ESCALATION_CONTINUATION_CONTENT,
  ESCALATION_PROFILE,
  FRONT_DOOR_PROFILE,
  frontDoorTriageRule,
  isVoiceTriageEscalateEnabled,
  needsFallbackBridge,
  VOICE_TRIAGE_ESCALATE_FLAG,
} from "../voice-triage-escalate.js";

// The gate ignores the config arg (flags resolve from the override cache +
// bundled registry), so a bare cast is sufficient.
const CONFIG = {} as AssistantConfig;

afterEach(() => {
  clearFeatureFlagOverridesCache();
});

describe("voice-triage-escalate profiles", () => {
  test("front door is the fast Speed profile, escalation is the Quality profile", () => {
    expect(FRONT_DOOR_PROFILE).toBe("cost-optimized");
    expect(ESCALATION_PROFILE).toBe("quality-optimized");
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

describe("front-door triage rule", () => {
  const rule = frontDoorTriageRule();

  test("instructs the model to triage before answering and emit [ESCALATE]", () => {
    expect(rule).toContain("TRIAGE FIRST");
    expect(rule).toContain(ESCALATE_MARKER);
    // Must decide up front — never answer, then bail (spoken audio is final).
    expect(rule.toLowerCase()).toContain("before you begin answering");
  });

  test("lists tool uncertainty as an escalate trigger (no fabrication)", () => {
    expect(rule.toLowerCase()).toContain("tool");
  });
});

describe("escalated continuation rule", () => {
  const rule = escalatedContinuationRule();

  test("tells the quality model to continue without re-greeting or repeating", () => {
    expect(rule.toLowerCase()).toContain("continue");
    expect(rule.toLowerCase()).toContain("do not greet again");
  });

  test("forbids the quality model from emitting [ESCALATE] again", () => {
    expect(rule).toContain(ESCALATE_MARKER);
    expect(rule.toLowerCase()).toContain("never emit");
  });
});

describe("needsFallbackBridge", () => {
  test("false when the model spoke a real holding phrase before the marker", () => {
    expect(
      needsFallbackBridge("Let me think about that for a second. [ESCALATE]"),
    ).toBe(false);
  });

  test("true for a bare marker with no holding phrase", () => {
    expect(needsFallbackBridge("[ESCALATE]")).toBe(true);
  });

  test("true when only post-marker text exists — that text was never spoken", () => {
    // Regression: the fallback decision must measure text BEFORE the marker.
    // Post-marker text is suppressed from TTS, so counting it would skip the
    // fallback and leave the caller in silence during the hand-off.
    expect(
      needsFallbackBridge(
        "[ESCALATE] here is my weak answer the model kept going",
      ),
    ).toBe(true);
  });
});

describe("escalation continuation content", () => {
  test("is an echo-suppressed synthetic prompt (parenthesized, non-user-speech)", () => {
    expect(ESCALATION_CONTINUATION_CONTENT.startsWith("(")).toBe(true);
    expect(ESCALATION_CONTINUATION_CONTENT.endsWith(")")).toBe(true);
  });
});

// This module is the surface-agnostic escalation *policy* (profiles, prompt
// rules, the fallback-bridge decision, the flag gate). The two-leg *routing*
// runs on the in-app Voice Mode surface (LiveVoiceSession), gated behind both
// the voice-mode and voice-triage-escalate flags — see
// live-voice/__tests__/live-voice-triage-escalate.test.ts for the orchestration
// coverage (flag gating, front-door → escalated hand-off, marker suppression,
// fallback bridge, barge-in). What remains for the manual cli-testing flow is
// true end-to-end audio: real TTS timing across the bridge, and the residual
// broadcast/persist raw-marker leak (issue #37850, shared by both voice
// surfaces) once that is addressed.
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
