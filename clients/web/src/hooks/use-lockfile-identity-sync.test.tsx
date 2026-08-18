import { act } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { LockfileAssistant } from "@/runtime/local-mode-host";

// Real module first, so the mock can pass through useLockfileAssistantName
// and only stub the write helper.
const actualLocalMode = await import("@/lib/local-mode");

const renameLockfileAssistantMock = mock(async (): Promise<boolean> => true);
mock.module("@/lib/local-mode", () => ({
  ...actualLocalMode,
  renameLockfileAssistant: renameLockfileAssistantMock,
}));

const { useLockfileIdentitySync } = await import(
  "@/hooks/use-lockfile-identity-sync"
);
const { useAssistantIdentityStore } = await import(
  "@/stores/assistant-identity-store"
);
const { useLockfileStore } = await import("@/stores/lockfile-store");

/** bun:test has no fake timers, so retry tests run on a real short delay. */
const TEST_RETRY_DELAY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockfileEntry(assistantId: string, name?: string): LockfileAssistant {
  return { assistantId, cloud: "local", name } as LockfileAssistant;
}

function resetStores(): void {
  renameLockfileAssistantMock.mockClear();
  useAssistantIdentityStore.getState().clearIdentity();
  useLockfileStore.setState({ lockfile: null, committed: false });
}

beforeEach(resetStores);

afterEach(() => {
  cleanup();
  resetStores();
});

describe("useLockfileIdentitySync", () => {
  test("renames the lockfile entry with the store's assistantId and name", () => {
    renderHook(() => useLockfileIdentitySync());
    expect(renameLockfileAssistantMock).not.toHaveBeenCalled();

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("Aria", "1.2.3", "assistant-1");
    });

    expect(renameLockfileAssistantMock).toHaveBeenCalledTimes(1);
    expect(renameLockfileAssistantMock).toHaveBeenCalledWith(
      "assistant-1",
      "Aria",
    );
  });

  test("does not fire while the name is null", () => {
    renderHook(() => useLockfileIdentitySync());

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity(null, "1.2.3", "assistant-1");
    });

    expect(renameLockfileAssistantMock).not.toHaveBeenCalled();
  });

  test("does not fire while the assistantId is null", () => {
    renderHook(() => useLockfileIdentitySync());

    act(() => {
      useAssistantIdentityStore.getState().setIdentity("Aria", "1.2.3");
    });

    expect(renameLockfileAssistantMock).not.toHaveBeenCalled();
  });

  test("re-fires when the store switches to a different named assistant", () => {
    renderHook(() => useLockfileIdentitySync());

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("Aria", "1.2.3", "assistant-1");
    });
    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("Bela", "1.2.3", "assistant-2");
    });

    expect(renameLockfileAssistantMock).toHaveBeenCalledTimes(2);
    expect(renameLockfileAssistantMock).toHaveBeenLastCalledWith(
      "assistant-2",
      "Bela",
    );
  });

  test("re-fires when the lockfile entry hydrates after the identity store", () => {
    renderHook(() => useLockfileIdentitySync());

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("Aria", "1.2.3", "assistant-1");
    });
    // First attempt ran against an unhydrated lockfile (helper no-ops on a
    // missing entry).
    expect(renameLockfileAssistantMock).toHaveBeenCalledTimes(1);

    act(() => {
      useLockfileStore.getState().setLockfile({
        assistants: [lockfileEntry("assistant-1", "Stale Name")],
        activeAssistant: "assistant-1",
      });
    });

    expect(renameLockfileAssistantMock).toHaveBeenCalledTimes(2);
    expect(renameLockfileAssistantMock).toHaveBeenLastCalledWith(
      "assistant-1",
      "Aria",
    );
  });

  test("re-fires when an unnamed lockfile entry hydrates after the identity store", () => {
    renderHook(() => useLockfileIdentitySync());

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("Aria", "1.2.3", "assistant-1");
    });
    // First attempt ran against an unhydrated lockfile (helper no-ops on a
    // missing entry).
    expect(renameLockfileAssistantMock).toHaveBeenCalledTimes(1);

    act(() => {
      useLockfileStore.getState().setLockfile({
        assistants: [lockfileEntry("assistant-1")],
        activeAssistant: "assistant-1",
      });
    });

    expect(renameLockfileAssistantMock).toHaveBeenCalledTimes(2);
    expect(renameLockfileAssistantMock).toHaveBeenLastCalledWith(
      "assistant-1",
      "Aria",
    );
  });

  test("retries once after a delay when the write fails", async () => {
    renameLockfileAssistantMock.mockResolvedValueOnce(false);
    renderHook(() => useLockfileIdentitySync(TEST_RETRY_DELAY_MS));

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("Aria", "1.2.3", "assistant-1");
    });
    expect(renameLockfileAssistantMock).toHaveBeenCalledTimes(1);

    await sleep(TEST_RETRY_DELAY_MS * 3);

    expect(renameLockfileAssistantMock).toHaveBeenCalledTimes(2);
    expect(renameLockfileAssistantMock).toHaveBeenLastCalledWith(
      "assistant-1",
      "Aria",
    );

    // The retry resolved true (mock default), so no further attempts.
    await sleep(TEST_RETRY_DELAY_MS * 3);
    expect(renameLockfileAssistantMock).toHaveBeenCalledTimes(2);
  });

  test("does not retry when the helper resolves true", async () => {
    renderHook(() => useLockfileIdentitySync(TEST_RETRY_DELAY_MS));

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("Aria", "1.2.3", "assistant-1");
    });

    await sleep(TEST_RETRY_DELAY_MS * 3);
    expect(renameLockfileAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("unmounting cancels a pending failed-write retry", async () => {
    renameLockfileAssistantMock.mockResolvedValueOnce(false);
    const { unmount } = renderHook(() =>
      useLockfileIdentitySync(TEST_RETRY_DELAY_MS),
    );

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("Aria", "1.2.3", "assistant-1");
    });
    expect(renameLockfileAssistantMock).toHaveBeenCalledTimes(1);

    // Let the rejection settle so the retry timer gets scheduled, then unmount.
    await sleep(1);
    unmount();

    await sleep(TEST_RETRY_DELAY_MS * 3);
    expect(renameLockfileAssistantMock).toHaveBeenCalledTimes(1);
  });
});
