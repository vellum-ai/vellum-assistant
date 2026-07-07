import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useSupportsSlackChannelList } from "@/lib/backwards-compat/slack-channel-list";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

/** Read the gate synchronously through the exported hook variant. */
function readGateViaHook(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  return renderHook(() => useSupportsSlackChannelList()).result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive truth-table for the underlying semver gate lives in
// `utils.test.ts`; here we verify the 0.10.7 boundary plus the
// conservative-on-unknown policy through the public hook.
describe("useSupportsSlackChannelList", () => {
  test("reads false when the version is unknown", () => {
    expect(readGateViaHook(null)).toBe(false);
  });

  test("reads false for assistants below 0.10.7", () => {
    expect(readGateViaHook("0.10.6")).toBe(false);
    expect(readGateViaHook("0.9.0")).toBe(false);
  });

  test("reads true for assistants on 0.10.7+", () => {
    expect(readGateViaHook("0.10.7")).toBe(true);
    expect(readGateViaHook("0.11.0")).toBe(true);
    expect(readGateViaHook("1.0.0")).toBe(true);
  });

  test("reads false for unparseable versions", () => {
    expect(readGateViaHook("garbage")).toBe(false);
  });
});
