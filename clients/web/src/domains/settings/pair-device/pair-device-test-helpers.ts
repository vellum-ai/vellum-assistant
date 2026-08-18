/**
 * Shared scaffolding for the pair-device test files: the fetch stub with its
 * request log, JSON response builders, the pending-request fixture, and the
 * armed-timer capture harness standing in for fake timers (bun's test runner
 * has none). Test semantics stay in the test files; only plumbing lives here.
 */

import { mock } from "bun:test";

import type { RemoteWebPairingRequestSummary } from "@vellumai/service-contracts/remote-web-pairing";

/** Local-gateway base URL used across the pair-device tests. */
export const TEST_GATEWAY_BASE =
  "http://localhost:3000/assistant/__gateway/20100";

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

export interface RecordedFetch {
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

export interface TimerHarness {
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
