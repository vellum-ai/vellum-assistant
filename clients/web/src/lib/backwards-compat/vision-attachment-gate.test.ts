import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useVisionAttachmentGate } from "@/lib/backwards-compat/vision-attachment-gate";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

function check(version: string | null): boolean {
  setVersion(version);
  const { result } = renderHook(() => useVisionAttachmentGate());
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useVisionAttachmentGate", () => {
  test("returns true (gate active) when version is unknown", () => {
    expect(check(null)).toBe(true);
    expect(check("")).toBe(true);
  });

  test("returns true (gate active) for 0.10.0 stable — feature not yet shipped", () => {
    expect(check("0.10.0")).toBe(true);
  });

  test("returns false (gate inactive) for the target dev build and newer", () => {
    expect(check("0.10.0-dev.202606211252.5cf8576")).toBe(false);
    expect(check("0.10.0-dev.202606211300.abcdef")).toBe(false);
  });

  test("returns true (gate active) for older dev builds", () => {
    expect(check("0.10.0-dev.202606211200.abcdef")).toBe(true);
  });

  test("returns false (gate inactive) for 0.10.1+ stable", () => {
    expect(check("0.10.1")).toBe(false);
    expect(check("0.11.0")).toBe(false);
    expect(check("1.0.0")).toBe(false);
  });

  test("returns true (gate active) for older assistants", () => {
    expect(check("0.9.0")).toBe(true);
    expect(check("0.9.99")).toBe(true);
    expect(check("0.8.5")).toBe(true);
  });

  test("returns true for unparseable versions (conservative fallback)", () => {
    expect(check("not-a-version")).toBe(true);
    expect(check("0.8")).toBe(true);
  });
});
