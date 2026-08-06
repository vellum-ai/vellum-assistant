import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsNoninteractiveVoiceTurns } from "@/lib/backwards-compat/use-supports-noninteractive-voice-turns";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const SESSION_ASSISTANT_ID = "asst-session";

/** Read the gate synchronously through the exported hook. */
function readGate(
  version: string | null,
  identityAssistantId: string | null = SESSION_ASSISTANT_ID,
): boolean {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
  return renderHook(() =>
    useSupportsNoninteractiveVoiceTurns(SESSION_ASSISTANT_ID),
  ).result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Semver semantics and the session-assistant scoping truth-table live in
// `utils.test.ts` (`useAssistantSupports` / `useAssistantScopedSupports`).
// Here we verify the boundary on each side of MIN_VERSION (0.11.0 — the
// first release guaranteed to force `supportsDynamicUi: false` on voice
// turns) plus one scoping smoke case, exercised through the public hook.
// `false` means the voice room keeps its fallback OAuth connect card
// reachable.
describe("useSupportsNoninteractiveVoiceTurns", () => {
  test("reads false below 0.11.0 — those assistants may still raise oauth_connect mid-call", () => {
    expect(readGate("0.10.10")).toBe(false);
    expect(readGate("0.10.9")).toBe(false);
  });

  test("reads true for assistants on 0.11.0+", () => {
    expect(readGate("0.11.0")).toBe(true);
    expect(readGate("0.11.1")).toBe(true);
  });

  test("reads false when the identity version belongs to a different assistant", () => {
    expect(readGate("0.11.0", "asst-other")).toBe(false);
  });
});
