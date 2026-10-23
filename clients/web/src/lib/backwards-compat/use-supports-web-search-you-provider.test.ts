import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  MIN_VERSION,
  supportsWebSearchYouProvider,
  useSupportsWebSearchYouProvider,
} from "@/lib/backwards-compat/use-supports-web-search-you-provider";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null): void {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version, null);
}

function readHook(): boolean {
  return renderHook(() => useSupportsWebSearchYouProvider()).result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("web-search You.com provider gate", () => {
  test("false when version is unknown", () => {
    setVersion(null);
    expect(readHook()).toBe(false);
    expect(supportsWebSearchYouProvider()).toBe(false);
  });

  test("false for assistants older than MIN_VERSION", () => {
    setVersion("0.12.6");
    expect(readHook()).toBe(false);
    expect(supportsWebSearchYouProvider()).toBe(false);
  });

  test("true at and after MIN_VERSION", () => {
    setVersion(MIN_VERSION);
    expect(readHook()).toBe(true);
    expect(supportsWebSearchYouProvider()).toBe(true);
    setVersion("0.13.0");
    expect(supportsWebSearchYouProvider()).toBe(true);
  });
});
