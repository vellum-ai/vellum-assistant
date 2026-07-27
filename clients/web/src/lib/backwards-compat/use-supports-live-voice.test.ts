import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsLiveVoice } from "@/lib/backwards-compat/use-supports-live-voice";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ASSISTANT_ID = "asst-owner";

/** Read the gate synchronously through the exported hook, scoped to OWNER_ASSISTANT_ID. */
function readGate(
  version: string | null,
  identityAssistantId: string | null = OWNER_ASSISTANT_ID,
): boolean {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
  return renderHook(() => useSupportsLiveVoice(OWNER_ASSISTANT_ID)).result
    .current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive semver + owner-scoping truth-table lives in `utils.test.ts`
// (`useAssistantSupports` / `useAssistantScopedSupports`). Here we verify each
// side of the 0.10.12 boundary (the first release carrying
// `POST /v1/live-voice/preflight`), the conservative-on-unknown policy, and
// that a version fetched for a DIFFERENT assistant cannot authorize this one.
// `false` means the composer shows no live-voice entry point, so a click can
// never sail past the readiness check into a raw WebSocket failure.
describe("useSupportsLiveVoice", () => {
  test("false when version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("false for assistants on 0.10.11 and older", () => {
    expect(readGate("0.10.11")).toBe(false);
    expect(readGate("0.9.0")).toBe(false);
    // The `/v1/live-voice` WebSocket shell shipped in 0.7.0, but without the
    // preflight route the entry point still fails open into a raw connection
    // error — the gate deliberately tracks preflight, not the shell.
    expect(readGate("0.7.0")).toBe(false);
  });

  test("true for assistants on 0.10.12+", () => {
    expect(readGate("0.10.12")).toBe(true);
    expect(readGate("0.11.0")).toBe(true);
  });

  test("true for RC builds of the cutover patch", () => {
    expect(readGate("0.10.12-rc.1")).toBe(true);
  });

  test("false when the identity version belongs to a different assistant", () => {
    expect(readGate("0.10.12", "asst-other")).toBe(false);
  });

  test("false when no owner is provided even on a supported version", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", "0.10.12", OWNER_ASSISTANT_ID);
    expect(renderHook(() => useSupportsLiveVoice(null)).result.current).toBe(
      false,
    );
  });
});
