import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsPluginIcons } from "@/lib/backwards-compat/use-supports-plugin-icons";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

function check(version: string | null): boolean {
  setVersion(version);
  const { result } = renderHook(() => useSupportsPluginIcons());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useSupportsPluginIcons", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null)).toBe(false);
    expect(check("")).toBe(false);
  });

  test("returns true at exactly MIN_VERSION (0.10.5)", () => {
    expect(check("0.10.5")).toBe(true);
  });

  test("returns true for dev builds ahead of MIN_VERSION", () => {
    expect(check("0.10.5-dev.202606211252.5cf8576")).toBe(true);
  });

  test("returns true for versions above MIN_VERSION", () => {
    expect(check("0.10.6")).toBe(true);
    expect(check("0.11.0")).toBe(true);
    expect(check("1.0.0")).toBe(true);
  });

  test("returns false for versions below MIN_VERSION", () => {
    expect(check("0.10.4")).toBe(false);
    expect(check("0.9.0")).toBe(false);
  });

  test("returns false for unparseable versions", () => {
    expect(check("not-a-version")).toBe(false);
    expect(check("0.10")).toBe(false);
  });
});
