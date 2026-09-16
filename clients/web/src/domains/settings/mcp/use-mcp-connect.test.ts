import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type * as BrowserRuntime from "@/runtime/browser";
import type * as NativeAuth from "@/runtime/native-auth";

import type * as McpApi from "./mcp-api";
import { mcpQueryKeys } from "./mcp-query-keys";

const ASSISTANT_ID = "assistant-1";
const SERVER_ID = "example-server";
const DISPLAY_NAME = "Example Server";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type AuthStartResult = Awaited<ReturnType<typeof McpApi.startMcpAuth>>;
type AuthStatusResult = Awaited<ReturnType<typeof McpApi.pollMcpAuthStatus>>;
type ServerListResult = Awaited<ReturnType<typeof McpApi.fetchMcpServers>>;

let nativePlatform = true;
let startImplementation: () => Promise<AuthStartResult>;
let pollImplementation: () => Promise<AuthStatusResult>;
let listImplementation: () => Promise<ServerListResult>;

const startMcpAuthMock = mock(
  async (_assistantId: string, _serverId: string) => startImplementation(),
);
const pollMcpAuthStatusMock = mock(
  async (_assistantId: string, _serverId: string) => pollImplementation(),
);
const fetchMcpServersMock = mock(
  async (_assistantId: string) => listImplementation(),
);

mock.module(
  "./mcp-api",
  (): Partial<typeof McpApi> => ({
    startMcpAuth: startMcpAuthMock,
    pollMcpAuthStatus: pollMcpAuthStatusMock,
    fetchMcpServers: fetchMcpServersMock,
  }),
);

let browserFinishedCallback: (() => void) | null = null;
let browserListenerSubscriptions = 0;
let browserListenerUnsubscriptions = 0;
const openExternalUrlMock = mock(async (_url: string) => {});

mock.module(
  "@/runtime/browser",
  (): Partial<typeof BrowserRuntime> => ({
    openExternalUrl: openExternalUrlMock,
    openUrlFinishedListener: (callback: () => void) => {
      browserFinishedCallback = callback;
      browserListenerSubscriptions += 1;
      let subscribed = true;
      return () => {
        if (subscribed) {
          subscribed = false;
          browserListenerUnsubscriptions += 1;
        }
        if (browserFinishedCallback === callback) {
          browserFinishedCallback = null;
        }
      };
    },
  }),
);

mock.module(
  "@/runtime/native-auth",
  (): Partial<typeof NativeAuth> => ({
    isNativePlatform: () => nativePlatform,
  }),
);

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
}));

const captureErrorMock = mock((_error: unknown, _options: unknown) => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

const { useMcpConnect } = await import("./use-mcp-connect");
const { CONNECTION_POLL_WINDOW_MS } = await import(
  "@/lib/auth/oauth-connect-timing"
);

const clients = new Set<QueryClient>();
const originalWindowOpen = window.open;

function connectedServers(): ServerListResult {
  return {
    servers: [
      {
        id: SERVER_ID,
        status: "connected",
        transport: {
          type: "streamable-http",
          url: "https://mcp.example.com/server",
        },
        hasOAuth: true,
        hasStaticAuth: false,
        authType: "none",
      },
    ],
  };
}

function legacyErrorServers(): ServerListResult {
  return {
    servers: [
      {
        ...connectedServers().servers[0]!,
        status: "error",
      },
    ],
  };
}

function createQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        retryDelay: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
  clients.add(client);
  return client;
}

function mountConnect(assistantId = ASSISTANT_ID, client = createQueryClient()) {
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }

  const view = renderHook(
    ({ currentAssistantId }: { currentAssistantId: string }) =>
      useMcpConnect(currentAssistantId),
    {
      initialProps: { currentAssistantId: assistantId },
      wrapper,
    },
  );
  return { ...view, client };
}

async function beginConnect(
  result: ReturnType<typeof mountConnect>["result"],
  prepare?: () => Promise<void>,
) {
  act(() => result.current.connect(SERVER_ID, prepare, DISPLAY_NAME));
  await waitFor(() => expect(startMcpAuthMock).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  nativePlatform = true;
  startImplementation = async () => ({
    auth_url: "https://auth.example.com/authorize",
    state: "state-1",
  });
  pollImplementation = async () => ({ status: "pending" });
  listImplementation = async () => legacyErrorServers();
  browserFinishedCallback = null;
  browserListenerSubscriptions = 0;
  browserListenerUnsubscriptions = 0;
  startMcpAuthMock.mockClear();
  pollMcpAuthStatusMock.mockClear();
  fetchMcpServersMock.mockClear();
  openExternalUrlMock.mockClear();
  captureErrorMock.mockClear();
  window.open = originalWindowOpen;
});

afterEach(() => {
  jest.useRealTimers();
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.clear();
  window.open = originalWindowOpen;
});

describe("useMcpConnect", () => {
  test("prepares, authorizes, and waits through legacy runtime errors until connected", async () => {
    nativePlatform = false;
    const prepareGate = deferred<void>();
    const prepare = mock(() => prepareGate.promise);
    const popup = {
      closed: false,
      opener: window,
      close: mock(() => {
        popup.closed = true;
      }),
      location: {
        replace: mock((_url: string) => {}),
      },
    };
    window.open = mock(() => popup) as unknown as typeof window.open;

    let authStatus = "pending";
    pollImplementation = async () => ({ status: authStatus });
    const firstRuntimeResponse = deferred<ServerListResult>();
    const secondRuntimeResponse = deferred<ServerListResult>();
    const connectedRuntimeResponse = deferred<ServerListResult>();
    const runtimeResponses = [
      firstRuntimeResponse,
      secondRuntimeResponse,
      connectedRuntimeResponse,
    ];
    listImplementation = () => runtimeResponses.shift()!.promise;
    const { result, client } = mountConnect();

    act(() => result.current.connect(SERVER_ID, prepare, DISPLAY_NAME));

    expect(result.current.attempt?.phase).toBe("starting");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(startMcpAuthMock).not.toHaveBeenCalled();

    prepareGate.resolve();
    await waitFor(() => expect(result.current.attempt?.phase).toBe("authorizing"));
    expect(startMcpAuthMock).toHaveBeenCalledWith(ASSISTANT_ID, SERVER_ID);
    expect(popup.location.replace).toHaveBeenCalledWith(
      "https://auth.example.com/authorize",
    );

    authStatus = "complete";
    await act(async () => {
      await client.invalidateQueries({
        queryKey: mcpQueryKeys.auth(
          ASSISTANT_ID,
          result.current.attempt!.operationId,
        ),
      });
    });
    await waitFor(() => expect(result.current.attempt?.phase).toBe("connecting"));
    expect(popup.close).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(fetchMcpServersMock).toHaveBeenCalledTimes(1));
    firstRuntimeResponse.resolve(legacyErrorServers());
    await waitFor(() => expect(result.current.attempt?.phase).toBe("connecting"));

    act(() => {
      void client.invalidateQueries({ queryKey: mcpQueryKeys.list(ASSISTANT_ID) });
    });
    await waitFor(() => expect(fetchMcpServersMock).toHaveBeenCalledTimes(2));
    secondRuntimeResponse.resolve(legacyErrorServers());
    await waitFor(() => expect(result.current.attempt?.phase).toBe("connecting"));

    act(() => {
      void client.invalidateQueries({ queryKey: mcpQueryKeys.list(ASSISTANT_ID) });
    });
    await waitFor(() => expect(fetchMcpServersMock).toHaveBeenCalledTimes(3));
    connectedRuntimeResponse.resolve(connectedServers());

    await waitFor(() => expect(result.current.attempt).toBeNull());
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("reports a start failure and retries the same connection successfully", async () => {
    const prepare = mock(async () => {});
    let startCalls = 0;
    startImplementation = async () => {
      startCalls += 1;
      if (startCalls === 1) {
        throw new Error("start failed");
      }
      return {
        auth_url: "https://auth.example.com/retry",
        state: "state-2",
      };
    };
    const { result } = mountConnect();

    await beginConnect(result, prepare);
    await waitFor(() => expect(result.current.attempt?.phase).toBe("error"));
    expect(result.current.attempt?.error).toBe(
      "Could not start the connection. Try again.",
    );
    expect(captureErrorMock).toHaveBeenCalledTimes(1);

    act(() => result.current.retry());

    await waitFor(() => expect(result.current.attempt?.phase).toBe("authorizing"));
    expect(startMcpAuthMock).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://auth.example.com/retry",
    );
  });

  test("keeps retrying while a stale runtime error is being refetched", async () => {
    startImplementation = async () => ({
      auth_url: "https://auth.example.com/already-authorized",
      state: "state",
      already_authenticated: true,
    });
    const successfulRetry = deferred<ServerListResult>();
    let listCalls = 0;
    listImplementation = async () => {
      listCalls += 1;
      if (listCalls <= 2) {
        throw new Error("runtime unavailable");
      }
      return successfulRetry.promise;
    };
    const { result } = mountConnect();

    await beginConnect(result);
    await waitFor(() => expect(result.current.attempt?.phase).toBe("error"));
    expect(result.current.attempt?.error).toBe(
      "Could not check the connection. Try again.",
    );
    expect(fetchMcpServersMock).toHaveBeenCalledTimes(2);

    act(() => result.current.retry());

    await waitFor(() => expect(fetchMcpServersMock).toHaveBeenCalledTimes(3));
    expect(result.current.attempt?.phase).toBe("connecting");
    expect(result.current.isBusy).toBe(true);

    successfulRetry.resolve(connectedServers());
    await waitFor(() => expect(result.current.attempt).toBeNull());
  });

  test("times out an authorization attempt without a real polling wait", async () => {
    jest.useFakeTimers();
    const { result } = mountConnect();

    await act(async () => {
      result.current.connect(SERVER_ID, undefined, DISPLAY_NAME);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.attempt?.phase).toBe("authorizing");

    act(() => {
      jest.advanceTimersByTime(CONNECTION_POLL_WINDOW_MS);
    });

    expect(result.current.attempt?.phase).toBe("error");
    expect(result.current.attempt?.error).toBe(
      "The connection is taking too long. You can retry or stop waiting.",
    );
  });

  test("stopWaiting ignores a late start result and removes the native listener", async () => {
    const startGate = deferred<AuthStartResult>();
    startImplementation = () => startGate.promise;
    const { result } = mountConnect();

    await beginConnect(result);
    expect(result.current.attempt?.phase).toBe("starting");
    expect(browserListenerSubscriptions).toBeGreaterThan(0);

    act(() => result.current.stopWaiting());
    expect(result.current.attempt).toBeNull();
    expect(browserListenerUnsubscriptions).toBe(browserListenerSubscriptions);

    startGate.resolve({
      auth_url: "https://auth.example.com/late",
      state: "late-state",
    });
    await act(async () => {
      await startGate.promise;
      await Promise.resolve();
    });

    expect(result.current.attempt).toBeNull();
    expect(openExternalUrlMock).not.toHaveBeenCalled();
    expect(startMcpAuthMock).toHaveBeenCalledTimes(1);
  });

  test("unmount ignores late work and detaches query observers and listeners", async () => {
    const startGate = deferred<AuthStartResult>();
    startImplementation = () => startGate.promise;
    const { result, unmount, client } = mountConnect();

    await beginConnect(result);
    unmount();

    expect(browserListenerUnsubscriptions).toBe(browserListenerSubscriptions);
    expect(
      client
        .getQueryCache()
        .getAll()
        .every((query) => query.getObserversCount() === 0),
    ).toBe(true);

    startGate.resolve({
      auth_url: "https://auth.example.com/late",
      state: "late-state",
    });
    await startGate.promise;
    await Promise.resolve();

    expect(openExternalUrlMock).not.toHaveBeenCalled();
    expect(startMcpAuthMock).toHaveBeenCalledTimes(1);
  });

  test("assistant switches reject the old result and start new work against the new assistant", async () => {
    const oldStart = deferred<AuthStartResult>();
    startImplementation = () =>
      startMcpAuthMock.mock.calls.length === 1
        ? oldStart.promise
        : Promise.resolve({
            auth_url: "https://auth.example.com/new-assistant",
            state: "new-state",
          });
    const { result, rerender } = mountConnect();

    await beginConnect(result);
    rerender({ currentAssistantId: "assistant-2" });
    await waitFor(() => expect(result.current.attempt).toBeNull());

    oldStart.resolve({
      auth_url: "https://auth.example.com/old-assistant",
      state: "old-state",
    });
    await oldStart.promise;
    await Promise.resolve();
    expect(openExternalUrlMock).not.toHaveBeenCalled();

    act(() => result.current.connect(SERVER_ID, undefined, DISPLAY_NAME));
    await waitFor(() => expect(result.current.attempt?.phase).toBe("authorizing"));
    expect(startMcpAuthMock.mock.calls[1]).toEqual(["assistant-2", SERVER_ID]);
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://auth.example.com/new-assistant",
    );
  });

  test("browser completion moves to waiting and immediately rechecks auth and runtime", async () => {
    const { result, client } = mountConnect();
    const invalidatedKeys: ReadonlyArray<unknown>[] = [];
    const originalInvalidate = client.invalidateQueries.bind(client);
    client.invalidateQueries = ((...args: Parameters<QueryClient["invalidateQueries"]>) => {
      if (args[0]?.queryKey) {
        invalidatedKeys.push(args[0].queryKey);
      }
      return originalInvalidate(...args);
    }) as QueryClient["invalidateQueries"];

    await beginConnect(result);
    await waitFor(() => expect(result.current.attempt?.phase).toBe("authorizing"));
    const operationId = result.current.attempt!.operationId;
    const pollCallsBeforeFinish = pollMcpAuthStatusMock.mock.calls.length;
    const finish = browserFinishedCallback;
    expect(finish).not.toBeNull();

    act(() => finish!());

    await waitFor(() => expect(result.current.attempt?.phase).toBe("waiting"));
    await waitFor(() =>
      expect(pollMcpAuthStatusMock.mock.calls.length).toBeGreaterThan(
        pollCallsBeforeFinish,
      ),
    );
    expect(invalidatedKeys).toContainEqual(
      mcpQueryKeys.auth(ASSISTANT_ID, operationId),
    );
    expect(invalidatedKeys).toContainEqual(mcpQueryKeys.list(ASSISTANT_ID));
  });
});
