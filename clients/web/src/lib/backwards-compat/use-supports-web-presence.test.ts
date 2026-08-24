import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  MIN_VERSION,
  useSupportsWebPresence,
} from "@/lib/backwards-compat/use-supports-web-presence";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ASSISTANT_ID = "asst-owner";

function setVersion(
  version: string | null,
  assistantId: string | null = OWNER_ASSISTANT_ID,
) {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, assistantId);
}

function readGate(
  version: string | null,
  assistantId: string | null = OWNER_ASSISTANT_ID,
): boolean {
  act(() => setVersion(version, assistantId));
  return renderHook(() => useSupportsWebPresence(OWNER_ASSISTANT_ID)).result
    .current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useSupportsWebPresence", () => {
  test("uses the exact route-introduction dev floor", () => {
    expect(MIN_VERSION).toBe("0.11.4-dev.202608192259.e726ce0");
  });

  test("returns false while the assistant version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("returns false for assistants older than the web-presence route", () => {
    expect(readGate("0.11.4")).toBe(false);
    expect(readGate("0.11.4-dev.202608192258.aaaaaaa")).toBe(false);
    expect(readGate("0.11.3")).toBe(false);
  });

  test("returns false for unparseable versions", () => {
    expect(readGate("not-a-version")).toBe(false);
    expect(readGate("0.11")).toBe(false);
  });

  test("returns false when the hydrated version belongs to another assistant", () => {
    expect(readGate("0.12.0", "asst-other")).toBe(false);
  });

  test("returns true for the route-introduction build and later versions", () => {
    expect(readGate(MIN_VERSION)).toBe(true);
    expect(readGate("0.11.4-dev.202608192300.aaaaaaa")).toBe(true);
    expect(readGate("0.11.5")).toBe(true);
    expect(readGate("1.0.0")).toBe(true);
  });

  test("re-renders when identity hydration flips the gate false to true", () => {
    setVersion("0.11.4");
    const { result } = renderHook(() =>
      useSupportsWebPresence(OWNER_ASSISTANT_ID),
    );
    expect(result.current).toBe(false);

    act(() => setVersion(MIN_VERSION));

    expect(result.current).toBe(true);
  });
});
