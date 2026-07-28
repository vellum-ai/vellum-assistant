/**
 * Tests for the ChatPage connecting watchdog.
 *
 * bun:test has no fake timers, so the hook's injectable `timeoutMs` runs at a
 * few real milliseconds here; assertions wait past it with real sleeps.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const captureErrorMock = mock(() => undefined);
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

const { useStuckConnecting } = await import("./use-stuck-connecting");

const TIMEOUT_MS = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  captureErrorMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("useStuckConnecting", () => {
  test("stays un-stuck while connecting resolves within the bound", async () => {
    const { result, rerender } = renderHook(
      ({ reason }: { reason: string | null }) =>
        useStuckConnecting(reason, TIMEOUT_MS),
      { initialProps: { reason: "auth_loading" as string | null } },
    );
    expect(result.current.connectingStuck).toBe(false);

    // Connecting resolves before the bound — watchdog disarms.
    rerender({ reason: null });
    await sleep(TIMEOUT_MS * 2);
    expect(result.current.connectingStuck).toBe(false);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("escalates to stuck and captures once after the bound", async () => {
    const { result } = renderHook(() =>
      useStuckConnecting("assistant_loading", TIMEOUT_MS),
    );
    await waitFor(() => {
      expect(result.current.connectingStuck).toBe(true);
    });
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const [error, opts] = captureErrorMock.mock.calls[0] as unknown as [
      Error,
      { context: string; tags: Record<string, string> },
    ];
    expect(error.message).toContain("assistant_loading");
    expect(opts.context).toBe("chat.connecting_stuck");
    expect(opts.tags.reason).toBe("assistant_loading");
  });

  test("reset re-arms the watchdog for another full episode", async () => {
    const { result } = renderHook(() =>
      useStuckConnecting("assistant_loading", TIMEOUT_MS),
    );
    await waitFor(() => {
      expect(result.current.connectingStuck).toBe(true);
    });

    act(() => {
      result.current.resetStuckConnecting();
    });
    expect(result.current.connectingStuck).toBe(false);

    // Still connecting after the retry — escalates (and captures) again.
    await waitFor(() => {
      expect(result.current.connectingStuck).toBe(true);
    });
    expect(captureErrorMock).toHaveBeenCalledTimes(2);
  });

  test("clearing the reason after stuck clears the state", async () => {
    const { result, rerender } = renderHook(
      ({ reason }: { reason: string | null }) =>
        useStuckConnecting(reason, TIMEOUT_MS),
      { initialProps: { reason: "auth_loading" as string | null } },
    );
    await waitFor(() => {
      expect(result.current.connectingStuck).toBe(true);
    });

    rerender({ reason: null });
    expect(result.current.connectingStuck).toBe(false);
  });
});
