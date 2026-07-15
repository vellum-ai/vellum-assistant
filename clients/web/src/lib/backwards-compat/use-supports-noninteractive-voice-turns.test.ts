import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsNoninteractiveVoiceTurns } from "@/lib/backwards-compat/use-supports-noninteractive-voice-turns";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

/** Read the gate synchronously through the exported hook. */
function readGate(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  return renderHook(() => useSupportsNoninteractiveVoiceTurns()).result
    .current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive semver truth-table lives in `utils.test.ts`. Here we verify the
// boundary on each side of MIN_VERSION (0.10.10 — the first release that can
// force `supportsDynamicUi: false` on voice turns; v0.10.9 shipped without it)
// plus the conservative-on-unknown policy, exercised through the public hook.
// `false` means the voice room keeps its fallback OAuth connect card reachable.
describe("useSupportsNoninteractiveVoiceTurns", () => {
  test("reads false when the version is unknown (fallback card stays available)", () => {
    expect(readGate(null)).toBe(false);
  });

  test("reads false below 0.10.10 — those assistants can still raise oauth_connect mid-call", () => {
    expect(readGate("0.10.9")).toBe(false);
    expect(readGate("0.10.8")).toBe(false);
    expect(readGate("0.9.0")).toBe(false);
  });

  test("reads true for assistants on 0.10.10+", () => {
    expect(readGate("0.10.10")).toBe(true);
    expect(readGate("0.11.0")).toBe(true);
    expect(readGate("1.0.0")).toBe(true);
  });

  test("reads true for dev builds on the 0.10.10 base", () => {
    expect(readGate("0.10.10-dev.202607150000.abc1234")).toBe(true);
  });

  test("reads false for unparseable versions", () => {
    expect(readGate("garbage")).toBe(false);
    expect(readGate("0.11")).toBe(false);
  });
});
