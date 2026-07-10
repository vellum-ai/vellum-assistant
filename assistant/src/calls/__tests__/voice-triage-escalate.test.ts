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

describe("escalation continuation content", () => {
  test("is an echo-suppressed synthetic prompt (parenthesized, non-user-speech)", () => {
    expect(ESCALATION_CONTINUATION_CONTENT.startsWith("(")).toBe(true);
    expect(ESCALATION_CONTINUATION_CONTENT.endsWith(")")).toBe(true);
  });
});

// Controller-level orchestration in CallController.streamTtsTokens is not
// covered by unit tests here — CallController needs a live transport,
// conversation, and TTS provider to instantiate. These document the intended
// integration coverage (a harnessed call-controller test or the manual
// cli-testing flow) for the two-leg escalation path.
describe("call-controller escalation orchestration (integration — TODO)", () => {
  test.todo(
    "flag OFF: a single leg runs on the call-site default profile, no [ESCALATE] rule in the prompt",
    () => {},
  );
  test.todo(
    "flag ON, simple turn: the front-door (cost-optimized) leg answers and no escalation leg runs",
    () => {},
  );
  test.todo(
    "flag ON, tricky turn: [ESCALATE] triggers a second (quality-optimized) leg that shares the TTS stream and end-of-turn signal",
    () => {},
  );
  test.todo(
    "front-door text after [ESCALATE] is suppressed and never spoken; only the bridge before the marker reaches TTS",
    () => {},
  );
  test.todo(
    "bare [ESCALATE] with no holding phrase injects the fallback bridge before the quality leg so there is no dead air",
    () => {},
  );
  test.todo(
    "barge-in during the bridge or hand-off aborts both legs via runSignal",
    () => {},
  );
});
