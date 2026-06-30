import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  resolveSupportsNewChatPlugins,
  supportsNewChatPlugins,
  useSupportsNewChatPlugins,
} from "@/lib/backwards-compat/use-supports-new-chat-plugins";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive truth-table for the underlying semver gate lives in
// `utils.test.ts`. Here we verify the boundary on each side of 0.10.4
// plus the conservative-on-unknown policy and the awaiting send-path
// variant.
describe("supportsNewChatPlugins", () => {
  test("returns false when the version is unknown", () => {
    setVersion(null);
    expect(supportsNewChatPlugins()).toBe(false);
  });

  test("returns false for assistants on 0.10.3 and older", () => {
    setVersion("0.10.3");
    expect(supportsNewChatPlugins()).toBe(false);
    setVersion("0.10.0");
    expect(supportsNewChatPlugins()).toBe(false);
    setVersion("0.9.0");
    expect(supportsNewChatPlugins()).toBe(false);
  });

  test("returns true for assistants on 0.10.4+", () => {
    setVersion("0.10.4");
    expect(supportsNewChatPlugins()).toBe(true);
    setVersion("0.11.0");
    expect(supportsNewChatPlugins()).toBe(true);
    setVersion("1.0.0");
    expect(supportsNewChatPlugins()).toBe(true);
  });

  test("returns false for unparseable versions", () => {
    setVersion("garbage");
    expect(supportsNewChatPlugins()).toBe(false);
    setVersion("0.10");
    expect(supportsNewChatPlugins()).toBe(false);
  });
});

describe("useSupportsNewChatPlugins", () => {
  test("returns false while unresolved and on older daemons", () => {
    setVersion(null);
    expect(renderHook(() => useSupportsNewChatPlugins()).result.current).toBe(
      false,
    );
    setVersion("0.10.3");
    expect(renderHook(() => useSupportsNewChatPlugins()).result.current).toBe(
      false,
    );
  });

  test("returns true on supported daemons", () => {
    setVersion("0.10.4");
    expect(renderHook(() => useSupportsNewChatPlugins()).result.current).toBe(
      true,
    );
  });
});

describe("resolveSupportsNewChatPlugins", () => {
  test("resolves false for an older daemon once the version is known", async () => {
    setVersion("0.10.3");
    expect(await resolveSupportsNewChatPlugins()).toBe(false);
  });

  test("resolves true for a supported daemon once the version is known", async () => {
    setVersion("0.10.4");
    expect(await resolveSupportsNewChatPlugins()).toBe(true);
  });
});
