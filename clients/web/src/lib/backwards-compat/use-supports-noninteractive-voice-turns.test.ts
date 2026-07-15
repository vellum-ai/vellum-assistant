import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsNoninteractiveVoiceTurns } from "@/lib/backwards-compat/use-supports-noninteractive-voice-turns";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const SESSION_ASSISTANT_ID = "asst-session";

/** Read the gate synchronously through the exported hook. */
function readGate(
  version: string | null,
  sessionAssistantId: string | null | undefined = SESSION_ASSISTANT_ID,
  identityAssistantId: string | null = SESSION_ASSISTANT_ID,
): boolean {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
  return renderHook(() =>
    useSupportsNoninteractiveVoiceTurns(sessionAssistantId),
  ).result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive semver truth-table lives in `utils.test.ts`. Here we verify the
// boundary on each side of MIN_VERSION (0.11.0 — the first release guaranteed
// to force `supportsDynamicUi: false` on voice turns), the conservative-on-
// unknown policy, and the session-assistant scoping, exercised through the
// public hook. `false` means the voice room keeps its fallback OAuth connect
// card reachable.
describe("useSupportsNoninteractiveVoiceTurns", () => {
  test("reads false when the version is unknown (fallback card stays available)", () => {
    expect(readGate(null)).toBe(false);
  });

  test("reads false below 0.11.0 — those assistants may still raise oauth_connect mid-call", () => {
    expect(readGate("0.10.10")).toBe(false);
    expect(readGate("0.10.9")).toBe(false);
    expect(readGate("0.9.0")).toBe(false);
  });

  test("reads true for assistants on 0.11.0+", () => {
    expect(readGate("0.11.0")).toBe(true);
    expect(readGate("0.11.1")).toBe(true);
    expect(readGate("1.0.0")).toBe(true);
  });

  test("reads true for dev builds on the 0.11.0 base", () => {
    expect(readGate("0.11.0-dev.202607150000.abc1234")).toBe(true);
  });

  test("reads false for unparseable versions", () => {
    expect(readGate("garbage")).toBe(false);
    expect(readGate("0.11")).toBe(false);
  });

  test("reads false when the identity version belongs to a different assistant", () => {
    // An identity switch/re-hydration mid-call: the hydrated version no
    // longer describes the assistant that owns the voice session, so it
    // must not hide that session's fallback card.
    expect(readGate("0.11.0", SESSION_ASSISTANT_ID, "asst-other")).toBe(false);
  });

  test("reads false when the session has no assistant resolved", () => {
    expect(readGate("0.11.0", null)).toBe(false);
    // Passed explicitly (a default parameter would swallow `undefined`).
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", "0.11.0", SESSION_ASSISTANT_ID);
    const { result } = renderHook(() =>
      useSupportsNoninteractiveVoiceTurns(undefined),
    );
    expect(result.current).toBe(false);
  });

  test("reads false when the identity store has no owner recorded", () => {
    expect(readGate("0.11.0", SESSION_ASSISTANT_ID, null)).toBe(false);
  });
});
