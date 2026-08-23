/**
 * Shared scaffolding for the pair-device test files: the fetch stub with its
 * request log, JSON response builders, the pending-request fixture, the
 * tunnel-probe mock, the query-client wrapper, and the armed-timer capture
 * harness standing in for fake timers (bun's test runner has none). Test
 * semantics stay in the test files; only plumbing lives here.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mock } from "bun:test";
import { createElement, type ReactElement, type ReactNode } from "react";

import type { RemoteWebPairingRequestSummary } from "@vellumai/service-contracts/remote-web-pairing";

import type { IntegrationsIngressStatusGetResponse } from "@/generated/daemon/types.gen";

/** Local-gateway base URL used across the pair-device tests. */
export const TEST_GATEWAY_BASE =
  "http://localhost:3000/assistant/__gateway/20100";

/** An assistant version below the ingress-status floor, so no probe goes out. */
export const VERSION_BELOW_INGRESS_STATUS = "0.11.5";

/**
 * A fresh query client and the provider wrapper around it, which anything
 * rendering the tunnel-status probe needs. Retries are off so a failing probe
 * reaches its error state inside a test's patience.
 */
export function createQueryClientWrapper(): {
  client: QueryClient;
  wrapper: (props: { children: ReactNode }) => ReactElement;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    client,
    wrapper: ({ children }) =>
      createElement(QueryClientProvider, { client }, children),
  };
}

/**
 * Swap the generated ingress-status call for a mock the caller steers. Call it
 * at the top level of a test file, before importing the module under test, and
 * `reset()` it in `beforeEach`.
 *
 * Mocking the SDK call, rather than only reading TanStack's `fetchStatus`, is
 * what lets a test count probes: an imperative `refetch()` that a guard should
 * have swallowed leaves no trace in the query state but does show up here.
 */
export async function installIngressProbe(
  defaultResponse: IntegrationsIngressStatusGetResponse,
) {
  let response = defaultResponse;
  let failure: Error | null = null;
  let stalls = false;

  const probe = mock(async () => {
    if (stalls) {
      await new Promise(() => {});
    }
    if (failure) {
      throw failure;
    }
    return {
      data: response,
      error: undefined,
      response: new Response(null, { status: 200 }),
    };
  });

  /* Spread over the real module rather than replacing it: the generated SDK is
     a single barrel that the query-options barrel also pulls from, and a bare
     object drops every export not named here. */
  const realDaemonSdk = await import("@/generated/daemon/sdk.gen");
  mock.module("@/generated/daemon/sdk.gen", () => ({
    ...realDaemonSdk,
    integrationsIngressStatusGet: probe,
  }));

  return {
    /** The mocked call itself, for call-count assertions. */
    probe,
    /** Answer every probe from here on with this response. */
    respondWith(next: IntegrationsIngressStatusGetResponse) {
      response = next;
    },
    /** Fail every probe from here on, the way a dead daemon would. */
    failWith(error: Error) {
      failure = error;
    },
    /** Leave every probe from here on in flight, the way a slow daemon would. */
    stall() {
      stalls = true;
    },
    /** Back to the default answer, with the call log cleared. */
    reset() {
      response = defaultResponse;
      failure = null;
      stalls = false;
      probe.mockClear();
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function pendingRequest(
  overrides: Partial<RemoteWebPairingRequestSummary> = {},
): RemoteWebPairingRequestSummary {
  return {
    requestId: "req-1",
    userCode: "WXYZ-1234",
    publicBaseUrl: "https://foo.ts.net",
    requestedAt: "2026-08-17T10:00:00.000Z",
    expiresAt: "2026-08-17T10:10:00.000Z",
    requesterIp: "203.0.113.7",
    requesterUserAgent: "Mozilla/5.0",
    viaEdgeProxy: false,
    ...overrides,
  };
}

interface RecordedFetch {
  url: string;
  init: RequestInit | undefined;
}

/** The recorded fetch's parsed JSON body, or `null` when it had none. */
export function requestBody(recorded: RecordedFetch | undefined): unknown {
  return typeof recorded?.init?.body === "string"
    ? JSON.parse(recorded.init.body)
    : null;
}

const originalFetch = globalThis.fetch;

/** Requests recorded by {@link installFetch}, oldest first. */
export const fetchLog: RecordedFetch[] = [];

/**
 * Replace `globalThis.fetch` with a recording stub answering via `respond`.
 * Pair with {@link resetFetchLog} in `beforeEach` and {@link restoreFetch} in
 * `afterEach`.
 */
export function installFetch(
  respond: (url: string) => Response | Promise<Response>,
) {
  const fetchMock = mock(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchLog.push({ url, init });
    return respond(url);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

export function resetFetchLog() {
  fetchLog.length = 0;
}

export function restoreFetch() {
  globalThis.fetch = originalFetch;
}

export interface ArmedTimer {
  handler: () => void;
  delay: number;
  cleared: boolean;
}

interface TimerHarness {
  /** Every interval armed since {@link TimerHarness.install}, oldest first. */
  timers: ArmedTimer[];
  install: () => void;
  restore: () => void;
}

/**
 * Capture `setInterval` arms instead of scheduling them, so tests fire ticks
 * by hand. While installed, `waitFor` (which needs real timers) cannot be
 * used; flush with `act` instead.
 */
export function createTimerHarness(): TimerHarness {
  const timers: ArmedTimer[] = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  return {
    timers,
    install() {
      globalThis.setInterval = ((handler: () => void, delay: number) => {
        timers.push({ handler, delay, cleared: false });
        return timers.length as unknown as ReturnType<typeof setInterval>;
      }) as typeof globalThis.setInterval;
      globalThis.clearInterval = ((id: number) => {
        const timer = timers[id - 1];
        if (timer) {
          timer.cleared = true;
        }
      }) as typeof globalThis.clearInterval;
    },
    restore() {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      timers.length = 0;
    },
  };
}
