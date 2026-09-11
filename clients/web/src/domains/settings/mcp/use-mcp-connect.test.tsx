import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { createElement, type PropsWithChildren } from "react";

import { mcpServer } from "../integration-test-fixtures";
import type {
  McpServerEntry,
  pollMcpAuthStatus,
  startMcpAuth,
} from "./mcp-api";

type StartResult = Awaited<ReturnType<typeof startMcpAuth>>;
type AuthStatus = Awaited<ReturnType<typeof pollMcpAuthStatus>>;
let native = false;
let electron = false;
let status: AuthStatus;
let servers: McpServerEntry[];
let browserFinished: (() => void) | undefined;
const start = mock(
  async (): Promise<StartResult> => ({
    state: "oauth-state",
    auth_url: "https://example.com/authorize",
    attempt_id: "attempt-1",
  }),
);
const poll = mock(async () => status);
const list = mock(async () => ({ servers }));
const cancel = mock(
  async (_assistantId: string, _serverId: string, _attemptId: string) => ({
    cancelled: true,
  }),
);
const openNative = mock(async () => true);
const capture = mock(() => {});
const actualApi = await import("./mcp-api");
mock.module("./mcp-api", () => ({
  ...actualApi,
  startMcpAuth: start,
  pollMcpAuthStatus: poll,
  fetchMcpServers: list,
  cancelMcpAuth: cancel,
}));
const actualNative = await import("@/runtime/native-auth");
mock.module("@/runtime/native-auth", () => ({
  ...actualNative,
  isNativePlatform: () => native,
}));
mock.module("@/runtime/is-electron", () => ({ isElectron: () => electron }));
const actualBrowser = await import("@/runtime/browser");
mock.module("@/runtime/browser", () => ({
  ...actualBrowser,
  openUrlInNewTab: openNative,
  openUrlFinishedListener: (callback: () => void) => {
    browserFinished = callback;
    return () => {
      browserFinished = undefined;
    };
  },
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: capture }));
mock.module("@/lib/auth/oauth-connect-timing", () => ({
  CONNECTION_POLL_INTERVAL_MS: 60_000,
  CONNECTION_POLL_WINDOW_MS: 1_500,
}));
const { useMcpConnect } = await import("./use-mcp-connect");

let popup: {
  opener: unknown;
  close: ReturnType<typeof mock>;
  location: { replace: ReturnType<typeof mock> };
};
let openPopup: ReturnType<typeof mock>;
const clients: QueryClient[] = [];

function renderConnect() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  clients.push(client);
  return renderHook(() => useMcpConnect("assistant-1"), {
    wrapper: ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client }, children),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  native = false;
  electron = false;
  status = { status: "pending", attempt_id: "attempt-1" };
  servers = [mcpServer({ lifecycleState: "connecting" })];
  browserFinished = undefined;
  start.mockReset();
  start.mockImplementation(async () => ({
    state: "oauth-state",
    auth_url: "https://example.com/authorize",
    attempt_id: "attempt-1",
  }));
  poll.mockClear();
  list.mockClear();
  cancel.mockReset();
  cancel.mockImplementation(async () => ({ cancelled: true }));
  openNative.mockClear();
  capture.mockClear();
  popup = {
    opener: {},
    close: mock(() => {}),
    location: { replace: mock(() => {}) },
  };
  openPopup = mock(() => popup);
  window.open = openPopup as unknown as typeof window.open;
  focusManager.setFocused(true);
});

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  focusManager.setFocused(undefined);
});

describe("useMcpConnect", () => {
  test("pre-opens a desktop popup before asynchronous preparation and prevents double starts", async () => {
    const preparation = deferred<void>();
    const prepare = mock(() => {
      expect(openPopup).toHaveBeenCalledTimes(1);
      return preparation.promise;
    });
    const { result } = renderConnect();
    act(() => {
      result.current.connect("example-integration", prepare);
      result.current.connect("example-integration", prepare);
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    act(() => preparation.resolve());
    await waitFor(() =>
      expect(popup.location.replace).toHaveBeenCalledWith(
        "https://example.com/authorize",
      ),
    );
    expect(popup.opener).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("a blocked popup preserves custom setup for an explicit retry", async () => {
    openPopup.mockImplementationOnce(() => null);
    const prepare = mock(async () => {});
    const { result } = renderConnect();
    act(() => result.current.connect("example-integration", prepare));
    expect(result.current.attempt?.phase).toBe("error");
    expect(prepare).not.toHaveBeenCalled();
    act(() => {
      result.current.retry();
      result.current.retry();
    });
    await waitFor(() =>
      expect(result.current.attempt?.phase).toBe("authorizing"),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  test("authorization completion keeps waiting until runtime is connected", async () => {
    const { result } = renderConnect();
    act(() => result.current.connect("example-integration"));
    await waitFor(() =>
      expect(result.current.attempt?.phase).toBe("authorizing"),
    );
    status = { status: "complete", attempt_id: "attempt-1" };
    act(() => browserFinished?.());
    await waitFor(() =>
      expect(result.current.attempt?.phase).toBe("connecting"),
    );
    expect(result.current.canCancel).toBe(false);
    servers = [mcpServer({ lifecycleState: "connected" })];
    act(() => browserFinished?.());
    await waitFor(() => expect(result.current.attempt).toBeNull());
  });

  test("runtime failure after authorization offers recovery without a false Connected state", async () => {
    status = { status: "complete", attempt_id: "attempt-1" };
    servers = [mcpServer({ lifecycleState: "error" })];
    const { result } = renderConnect();
    act(() => result.current.connect("example-integration"));
    await waitFor(() => expect(result.current.attempt?.phase).toBe("error"));
    expect(result.current.attempt?.error).toContain("could not connect");
    expect(result.current.canCancel).toBe(false);
  });

  test("native browser close and app resume refetch without a deep-link callback", async () => {
    native = true;
    const { result } = renderConnect();
    act(() => result.current.connect("example-integration"));
    await waitFor(() =>
      expect(openNative).toHaveBeenCalledWith("https://example.com/authorize"),
    );
    expect(openPopup).not.toHaveBeenCalled();
    const beforeClose = poll.mock.calls.length;
    act(() => browserFinished?.());
    await waitFor(() =>
      expect(poll.mock.calls.length).toBeGreaterThan(beforeClose),
    );
    status = { status: "complete", attempt_id: "attempt-1" };
    servers = [mcpServer({ lifecycleState: "connected" })];
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(result.current.attempt).toBeNull());
  });

  test("Electron opens authorization through the shell without a renderer popup", async () => {
    electron = true;
    const { result } = renderConnect();
    act(() => result.current.connect("example-integration"));
    await waitFor(() =>
      expect(openNative).toHaveBeenCalledWith("https://example.com/authorize"),
    );
    expect(openPopup).not.toHaveBeenCalled();
    expect(result.current.attempt?.phase).toBe("authorizing");
  });

  test("cancel sends the exact supported attempt and clears waiting only after confirmation", async () => {
    const pending = deferred<{ cancelled: boolean }>();
    cancel.mockImplementationOnce(() => pending.promise);
    const { result } = renderConnect();
    act(() => result.current.connect("example-integration"));
    await waitFor(() => expect(result.current.canCancel).toBe(true));
    act(() => {
      void result.current.dismiss();
    });
    expect(cancel).toHaveBeenCalledWith(
      "assistant-1",
      "example-integration",
      "attempt-1",
    );
    expect(result.current.isCancelling).toBe(true);
    expect(result.current.attempt).not.toBeNull();
    act(() => pending.resolve({ cancelled: true }));
    await waitFor(() => expect(result.current.attempt).toBeNull());
  });

  test("old assistants stop local waiting without calling cancellation", async () => {
    start.mockImplementationOnce(async () => ({
      state: "oauth-state",
      auth_url: "https://example.com/authorize",
    }));
    const { result } = renderConnect();
    act(() => result.current.connect("example-integration"));
    await waitFor(() =>
      expect(result.current.attempt?.phase).toBe("authorizing"),
    );
    expect(result.current.canCancel).toBe(false);
    await act(() => result.current.dismiss());
    expect(cancel).not.toHaveBeenCalled();
    expect(result.current.attempt).toBeNull();
  });

  test("a superseded cancellation never claims that another attempt was cancelled", async () => {
    cancel.mockImplementationOnce(async () => ({ cancelled: false }));
    const { result } = renderConnect();
    act(() => result.current.connect("example-integration"));
    await waitFor(() => expect(result.current.canCancel).toBe(true));
    await act(() => result.current.dismiss());
    expect(result.current.attempt?.phase).toBe("error");
    expect(result.current.canCancel).toBe(false);
    expect(result.current.attempt?.error).toContain("not confirmed");
  });

  test("a newer server attempt cannot complete an older UI attempt", async () => {
    status = { status: "complete", attempt_id: "attempt-2" };
    const { result } = renderConnect();
    act(() => result.current.connect("example-integration"));
    await waitFor(() => expect(result.current.attempt?.phase).toBe("error"));
    expect(list).not.toHaveBeenCalled();
    expect(result.current.attempt?.error).toBeTruthy();
  });

  test("completion without an attempt ID cannot complete a verified UI attempt", async () => {
    status = { status: "complete" };
    const { result } = renderConnect();
    act(() => result.current.connect("example-integration"));
    await waitFor(() => expect(result.current.attempt?.phase).toBe("error"));
    expect(list).not.toHaveBeenCalled();
    expect(result.current.attempt?.error).toBeTruthy();
  });

  test("legacy authorization without attempt IDs still waits for runtime readiness", async () => {
    start.mockImplementationOnce(async () => ({
      state: "oauth-state",
      auth_url: "https://example.com/authorize",
    }));
    status = { status: "complete" };
    const { result } = renderConnect();
    act(() => result.current.connect("example-integration"));
    await waitFor(() =>
      expect(result.current.attempt?.phase).toBe("connecting"),
    );
    expect(result.current.canCancel).toBe(false);
    servers = [mcpServer({ lifecycleState: "connected" })];
    act(() => browserFinished?.());
    await waitFor(() => expect(result.current.attempt).toBeNull());
  });

  test("unmount closes the blank popup and ignores a late start response", async () => {
    const pending = deferred<StartResult>();
    start.mockImplementationOnce(() => pending.promise);
    const { result, unmount } = renderConnect();
    act(() => result.current.connect("example-integration"));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    unmount();
    act(() =>
      pending.resolve({
        state: "oauth-state",
        auth_url: "https://example.com/authorize",
        attempt_id: "attempt-1",
      }),
    );
    await Promise.resolve();
    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(browserFinished).toBeUndefined();
  });

  test("timeouts stop polling and a late response cannot restart the attempt", async () => {
    const pending = deferred<StartResult>();
    start.mockImplementationOnce(() => pending.promise);
    const { result } = renderConnect();
    act(() => result.current.connect("example-integration"));
    await waitFor(() => expect(result.current.attempt?.phase).toBe("error"), {
      timeout: 2_500,
    });
    act(() =>
      pending.resolve({
        state: "oauth-state",
        auth_url: "https://example.com/authorize",
        attempt_id: "attempt-1",
      }),
    );
    await Promise.resolve();
    expect(result.current.attempt?.phase).toBe("error");
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
  });
});
