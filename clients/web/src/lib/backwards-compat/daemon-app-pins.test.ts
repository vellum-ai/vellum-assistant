import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsDaemonAppPins } from "@/lib/backwards-compat/daemon-app-pins";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function supportsAt(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("Test", version, "asst-1");
  return renderHook(() => useSupportsDaemonAppPins()).result.current;
}

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().setIdentity("Test", null, "asst-1");
});

describe("useSupportsDaemonAppPins", () => {
  /* The conservative answer, and the one that matters most: the version
     hydrates asynchronously, so this is what every first render sees. Reading
     `true` here would send a pin to a daemon with no route for it. */
  test("is false before the version is known", () => {
    expect(supportsAt(null)).toBe(false);
  });

  test("is false on a release older than the floor", () => {
    expect(supportsAt("0.11.4")).toBe(false);
    expect(supportsAt("0.11.5")).toBe(false);
  });

  /* A dev build cut from main before the daemon change landed shares the
     0.11.5 base, so only the timestamp separates it from one cut after. */
  test("is false for a dev build predating the floor", () => {
    expect(supportsAt("0.11.5-dev.202608241200.abc1234")).toBe(false);
  });

  test("is true for a dev build cut after the floor", () => {
    expect(supportsAt("0.11.5-dev.202608250900.def5678")).toBe(true);
  });

  test("is true for every later release", () => {
    expect(supportsAt("0.11.6")).toBe(true);
    expect(supportsAt("0.12.0")).toBe(true);
    expect(supportsAt("1.0.0")).toBe(true);
  });

  test("is false for an unparseable version", () => {
    expect(supportsAt("not-a-version")).toBe(false);
  });
});
