import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import {
  useProgressiveAttachmentLoadingPolicy,
  useSupportsProgressiveAttachmentLoading,
} from "@/lib/backwards-compat/use-supports-progressive-attachment-loading";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ID = "asst-owner";

function check(
  version: string | null,
  identityAssistantId: string | null = OWNER_ID,
): boolean {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
  const { result, unmount } = renderHook(() =>
    useSupportsProgressiveAttachmentLoading(OWNER_ID),
  );
  const supported = result.current;
  unmount();
  return supported;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useSupportsProgressiveAttachmentLoading", () => {
  test("keeps legacy attachment requests while the version is unknown or old", () => {
    expect(check(null)).toBe(false);
    expect(check("0.10.11")).toBe(false);
  });

  test("enables progressive attachment requests at 0.10.12 and above", () => {
    expect(check("0.10.12")).toBe(true);
    expect(check("0.10.12-dev.202607240100.abc1234")).toBe(true);
    expect(check("0.11.0")).toBe(true);
  });

  test("stays conservative when the identity belongs to another assistant", () => {
    expect(check("0.10.12", "asst-previous")).toBe(false);
  });
});

describe("useProgressiveAttachmentLoadingPolicy", () => {
  test("resolves known old assistants to inline and supported assistants to metadata", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.11", OWNER_ID);
    const { result } = renderHook(() =>
      useProgressiveAttachmentLoadingPolicy(OWNER_ID),
    );
    expect(result.current).toBe("inline");

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("assistant", "0.10.12", OWNER_ID);
    });
    expect(result.current).toBe("metadata");
  });

  test("stays pending for unknown or mismatched identity", () => {
    const { result } = renderHook(() =>
      useProgressiveAttachmentLoadingPolicy(OWNER_ID, 1_000),
    );
    expect(result.current).toBe("pending");

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("assistant", "0.10.12", "asst-other");
    });
    expect(result.current).toBe("pending");
  });

  test("falls back to inline after a bounded wait and resets on assistant switch", async () => {
    const { result, rerender } = renderHook(
      ({ assistantId }: { assistantId: string }) =>
        useProgressiveAttachmentLoadingPolicy(assistantId, 5),
      { initialProps: { assistantId: OWNER_ID } },
    );
    expect(result.current).toBe("pending");
    await waitFor(() => expect(result.current).toBe("inline"));

    rerender({ assistantId: "asst-next" });
    expect(result.current).toBe("pending");

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("assistant", "0.10.11", "asst-next");
    });
    expect(result.current).toBe("inline");
  });
});
