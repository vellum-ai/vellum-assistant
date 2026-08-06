import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { renderHook } from "@testing-library/react";

import { useSupportsSummarizeUpToHere } from "@/lib/backwards-compat/use-supports-summarize-up-to-here";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive truth-table for the underlying semver gate lives in
// `utils.test.ts`. Here we verify each side of the 0.10.8 boundary (the
// first release carrying `POST /v1/conversations/summarize`) plus the
// conservative-on-unknown policy. `false` means the per-message
// "Summarize up to here" action is hidden.
describe("useSupportsSummarizeUpToHere", () => {
  test("false when version is unknown", () => {
    setVersion(null);
    const { result } = renderHook(() => useSupportsSummarizeUpToHere());
    expect(result.current).toBe(false);
  });

  test("false for assistants on 0.10.7 and older", () => {
    setVersion("0.10.7");
    const { result } = renderHook(() => useSupportsSummarizeUpToHere());
    expect(result.current).toBe(false);
  });

  test("true for assistants on 0.10.8+", () => {
    setVersion("0.10.8");
    const { result } = renderHook(() => useSupportsSummarizeUpToHere());
    expect(result.current).toBe(true);
  });

  test("true for RC builds of the cutover patch", () => {
    setVersion("0.10.8-rc.1");
    const { result } = renderHook(() => useSupportsSummarizeUpToHere());
    expect(result.current).toBe(true);
  });
});
