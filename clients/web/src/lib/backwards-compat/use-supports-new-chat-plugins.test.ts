import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  resolveSupportsNewChatPlugins,
  useSupportsNewChatPlugins,
} from "@/lib/backwards-compat/use-supports-new-chat-plugins";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

/** Read the gate synchronously through the exported hook variant. */
function readGateViaHook(version: string | null): boolean {
  setVersion(version);
  return renderHook(() => useSupportsNewChatPlugins()).result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive truth-table for the underlying semver gate lives in
// `utils.test.ts`. Here we verify the boundary on each side of 0.10.5
// plus the conservative-on-unknown policy, exercised through the public
// hook and the awaiting send-path variant. (The snapshot read is a
// private helper; it is covered via these exported entry points.)
describe("useSupportsNewChatPlugins", () => {
  test("reads false when the version is unknown", () => {
    expect(readGateViaHook(null)).toBe(false);
  });

  test("reads false for assistants below 0.10.5 (incl. 0.10.4)", () => {
    expect(readGateViaHook("0.10.4")).toBe(false);
    expect(readGateViaHook("0.10.3")).toBe(false);
    expect(readGateViaHook("0.9.0")).toBe(false);
  });

  test("reads true for assistants on 0.10.5+", () => {
    expect(readGateViaHook("0.10.5")).toBe(true);
    expect(readGateViaHook("0.11.0")).toBe(true);
    expect(readGateViaHook("1.0.0")).toBe(true);
  });

  test("reads false for unparseable versions", () => {
    expect(readGateViaHook("garbage")).toBe(false);
    expect(readGateViaHook("0.10")).toBe(false);
  });
});

describe("resolveSupportsNewChatPlugins", () => {
  test("resolves false for an older daemon once the version is known", async () => {
    setVersion("0.10.3");
    expect(await resolveSupportsNewChatPlugins()).toBe(false);
  });

  test("resolves true for a supported daemon once the version is known", async () => {
    setVersion("0.10.5");
    expect(await resolveSupportsNewChatPlugins()).toBe(true);
  });
});
