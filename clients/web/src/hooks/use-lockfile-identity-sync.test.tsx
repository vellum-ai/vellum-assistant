import { act } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

const renameLockfileAssistantMock = mock(async (): Promise<void> => {});
mock.module("@/lib/local-mode", () => ({
  renameLockfileAssistant: renameLockfileAssistantMock,
}));

const { useLockfileIdentitySync } = await import(
  "@/hooks/use-lockfile-identity-sync"
);
const { useAssistantIdentityStore } = await import(
  "@/stores/assistant-identity-store"
);

beforeEach(() => {
  renameLockfileAssistantMock.mockClear();
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
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
});
