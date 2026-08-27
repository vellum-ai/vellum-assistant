import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { renderHook } from "@testing-library/react";

import {
  useDefaultProviderSettingsSupport,
  useSupportsDefaultProviderSettings,
} from "@/lib/backwards-compat/default-provider-settings";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const ASSISTANT_ID = "asst-1";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

function setVersionFor(assistantId: string, version: string | null) {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, assistantId);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive truth-table for the underlying semver gate lives in
// `utils.test.ts`. Here we verify each side of the 0.10.8 boundary
// plus the conservative-on-unknown policy.
describe("useSupportsDefaultProviderSettings", () => {
  test("false when version is unknown", () => {
    setVersion(null);
    const { result } = renderHook(() => useSupportsDefaultProviderSettings());
    expect(result.current).toBe(false);
  });

  test("false for assistants on 0.10.7 and older", () => {
    setVersion("0.10.7");
    const { result } = renderHook(() => useSupportsDefaultProviderSettings());
    expect(result.current).toBe(false);
  });

  test("true for assistants on 0.10.8+", () => {
    setVersion("0.10.8");
    const { result } = renderHook(() => useSupportsDefaultProviderSettings());
    expect(result.current).toBe(true);
  });

  test("true for RC builds of the cutover patch", () => {
    setVersion("0.10.8-rc.1");
    const { result } = renderHook(() => useSupportsDefaultProviderSettings());
    expect(result.current).toBe(true);
  });
});

// The form for callers that read the gate once: the same verdict, plus
// whether it was read against a resolved version.
describe("useDefaultProviderSettingsSupport", () => {
  test("reports the version as unknown until one hydrates", () => {
    const { result } = renderHook(() =>
      useDefaultProviderSettingsSupport(ASSISTANT_ID),
    );
    expect(result.current).toEqual({ supported: false, versionKnown: false });
  });

  test("reports a version hydrated for the assistant asked about", () => {
    setVersionFor(ASSISTANT_ID, "0.10.8");
    const { result } = renderHook(() =>
      useDefaultProviderSettingsSupport(ASSISTANT_ID),
    );
    expect(result.current).toEqual({ supported: true, versionKnown: true });
  });

  test("a version held for another assistant answers nothing about this one", () => {
    setVersionFor("asst-2", "0.10.8");
    const { result } = renderHook(() =>
      useDefaultProviderSettingsSupport(ASSISTANT_ID),
    );
    expect(result.current).toEqual({ supported: false, versionKnown: false });
  });

  test("an older assistant is a known version, not an unknown one", () => {
    setVersionFor(ASSISTANT_ID, "0.10.7");
    const { result } = renderHook(() =>
      useDefaultProviderSettingsSupport(ASSISTANT_ID),
    );
    expect(result.current).toEqual({ supported: false, versionKnown: true });
  });
});
