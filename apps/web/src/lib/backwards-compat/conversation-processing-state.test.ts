import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useConversationIsProcessing } from "@/lib/backwards-compat/conversation-processing-state";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

function isProcessing(inputs: {
  serverIsProcessing: boolean | undefined;
  isMarkedProcessingLocally: boolean;
}): boolean {
  const { result } = renderHook(() => useConversationIsProcessing(inputs));
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive truth-table for the underlying semver gate lives in
// `utils.test.ts`. Here we verify the processing-source branch on each
// side of the 0.8.8 boundary plus the conservative-on-unknown policy.
describe("useConversationIsProcessing", () => {
  test("on 0.8.8+, the server flag is the single source of truth", () => {
    // GIVEN an assistant new enough to surface `isProcessing` reliably
    setVersion("0.8.8");

    // WHEN the server reports processing
    // THEN the conversation is processing regardless of the client mirror
    expect(
      isProcessing({
        serverIsProcessing: true,
        isMarkedProcessingLocally: false,
      }),
    ).toBe(true);

    // AND when the server reports NOT processing, a stale client mirror
    // can no longer keep the indicator stuck on — this is the bug fix.
    expect(
      isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(false);

    // AND a missing server flag is treated as not processing.
    expect(
      isProcessing({
        serverIsProcessing: undefined,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(false);
  });

  test("on 0.8.8+, newer versions also trust the server flag alone", () => {
    // GIVEN assistants well past the cutover
    // WHEN the server reports NOT processing but the mirror is stale
    // THEN the stale mirror is ignored
    setVersion("0.9.0");
    expect(
      isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(false);

    setVersion("1.0.0");
    expect(
      isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(false);
  });

  test("treats RC builds of the cutover patch as trusting the server flag", () => {
    // GIVEN an RC build of the cutover patch, which ships the same
    // freshness handlers as the final 0.8.8
    setVersion("0.8.8-rc.1");

    // WHEN the server reports NOT processing but the mirror is stale
    // THEN RC testers get the server-only behavior
    expect(
      isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(false);

    setVersion("0.8.8-beta");
    expect(
      isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(false);
  });

  test("on 0.8.7 and older, falls back to OR-ing the client mirror", () => {
    // GIVEN an assistant that may omit `isProcessing` on the wire
    // WHEN only the client mirror marks the conversation as processing
    // THEN the legacy belt-and-suspenders fallback keeps it processing
    for (const version of ["0.8.7", "0.8.0", "0.7.0"]) {
      setVersion(version);
      expect(
        isProcessing({
          serverIsProcessing: false,
          isMarkedProcessingLocally: true,
        }),
      ).toBe(true);

      // AND the server flag still wins when it is the one set
      expect(
        isProcessing({
          serverIsProcessing: true,
          isMarkedProcessingLocally: false,
        }),
      ).toBe(true);

      // AND when neither source is set, the conversation is not processing
      expect(
        isProcessing({
          serverIsProcessing: false,
          isMarkedProcessingLocally: false,
        }),
      ).toBe(false);
    }
  });

  test("conservatively falls back to OR when the version is unknown", () => {
    // GIVEN the identity store has not hydrated a version yet
    setVersion(null);

    // WHEN only the client mirror marks the conversation as processing
    // THEN we keep the legacy OR until the version resolves, so a turn
    // in flight before hydration never loses its indicator
    expect(
      isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(true);
  });

  test("conservatively falls back to OR for unparseable versions", () => {
    // GIVEN a version string semver can't parse
    // WHEN only the client mirror marks the conversation as processing
    // THEN we fall back to the legacy OR rather than trusting an
    // unverifiable version
    setVersion("garbage");
    expect(
      isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(true);

    setVersion("0.8");
    expect(
      isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(true);
  });
});
