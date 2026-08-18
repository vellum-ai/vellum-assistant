/**
 * Tests for `usePendingPairingRequests`.
 *
 * `globalThis.fetch` is stubbed per-test (restored in `afterEach`) so the hook
 * runs through the real client module; `mock.module` is avoided because it
 * leaks across the other pair-device test files in a single-process run.
 * `setInterval`/`clearInterval` are stubbed with an armed-timer capture (bun's
 * test runner has no fake timers) so interval refreshes are driven by hand;
 * because the timer globals are stubbed, tests flush with `act` instead of
 * `waitFor` (which schedules real timers).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { RemoteWebPairingRequestSummary } from "@vellumai/service-contracts/remote-web-pairing";

import {
  createTimerHarness,
  fetchLog,
  installFetch,
  jsonResponse,
  pendingRequest,
  resetFetchLog,
  restoreFetch,
  TEST_GATEWAY_BASE as BASE,
  type ArmedTimer,
} from "./pair-device-test-helpers";
import { usePendingPairingRequests } from "./use-pending-pairing-requests";

const LIST_URL = `${BASE}/v1/remote-web/pairing-requests`;
const APPROVE_URL = `${LIST_URL}/approve`;
const DENY_URL = `${LIST_URL}/deny`;
const OTHER_BASE = "http://localhost:3000/assistant/__gateway/20200";
const OTHER_LIST_URL = `${OTHER_BASE}/v1/remote-web/pairing-requests`;
const OTHER_APPROVE_URL = `${OTHER_LIST_URL}/approve`;
const POLL_INTERVAL_MS = 5000;

function approvedResponse(): Response {
  return jsonResponse({
    status: "approved",
    verificationUri: "https://foo.ts.net/assistant/pair",
    expiresAt: "2026-08-17T10:10:00.000Z",
  });
}

function listCalls() {
  return fetchLog.filter((request) => request.url === LIST_URL);
}

/** Serve the list route with `summaries`; reassignable between polls. */
let listResponder: () => Response | Promise<Response>;

function serveList(summaries: RemoteWebPairingRequestSummary[]) {
  listResponder = () => jsonResponse({ requests: summaries });
}

function installRoutedFetch(
  actions: Partial<Record<string, () => Response | Promise<Response>>> = {},
) {
  installFetch((url) => {
    const respond = url === LIST_URL ? listResponder : actions[url];
    if (!respond) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return respond();
  });
}

// Armed-timer capture standing in for fake timers (bun has none); interval
// refreshes are driven by hand and flushed with `act` instead of `waitFor`.
const timerHarness = createTimerHarness();

function pollTimers(): ArmedTimer[] {
  return timerHarness.timers.filter(
    (timer) => timer.delay === POLL_INTERVAL_MS,
  );
}

/** Fire the (single) live poll interval once and flush the resulting poll. */
async function tickPoll() {
  const live = pollTimers().filter((timer) => !timer.cleared);
  expect(live).toHaveLength(1);
  await act(async () => {
    live[0]?.handler();
  });
}

function renderPendingRequests(base: string = BASE) {
  return renderHook(
    (props: { base: string }) => usePendingPairingRequests(props.base),
    { initialProps: { base } },
  );
}

async function renderWithList(summaries: RemoteWebPairingRequestSummary[]) {
  serveList(summaries);
  installRoutedFetch();
  let rendered!: ReturnType<typeof renderPendingRequests>;
  await act(async () => {
    rendered = renderPendingRequests();
  });
  return rendered;
}

beforeEach(() => {
  resetFetchLog();
  serveList([]);
  timerHarness.install();
});

afterEach(() => {
  cleanup();
  timerHarness.restore();
  restoreFetch();
});

describe("usePendingPairingRequests: polling", () => {
  test("fetches immediately on mount and arms a 5s interval", async () => {
    const { result } = await renderWithList([pendingRequest()]);

    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]?.init?.method).toBe("GET");
    expect(result.current.requests).toEqual([pendingRequest()]);
    expect(result.current.error).toBeNull();
    expect(pollTimers()).toHaveLength(1);
  });

  test("an interval tick replaces the list", async () => {
    const { result } = await renderWithList([pendingRequest({ requestId: "req-1" })]);

    serveList([pendingRequest({ requestId: "req-1" }), pendingRequest({ requestId: "req-2" })]);
    await tickPoll();

    expect(listCalls()).toHaveLength(2);
    expect(result.current.requests.map((r) => r.requestId)).toEqual([
      "req-1",
      "req-2",
    ]);
  });

  test("an unchanged poll keeps the same list reference", async () => {
    const { result } = await renderWithList([pendingRequest({ requestId: "req-1" })]);
    const initial = result.current.requests;

    await tickPoll();

    expect(listCalls()).toHaveLength(2);
    expect(result.current.requests).toBe(initial);
  });

  test("unmount clears the interval and aborts the in-flight poll", async () => {
    // A list response that never resolves, so the poll stays in flight.
    listResponder = () => new Promise<Response>(() => {});
    installRoutedFetch();

    let unmount!: () => void;
    await act(async () => {
      ({ unmount } = renderPendingRequests());
    });
    expect(listCalls()).toHaveLength(1);

    unmount();

    expect(pollTimers()[0]?.cleared).toBe(true);
    expect(listCalls()[0]?.init?.signal?.aborted).toBe(true);
    expect(listCalls()).toHaveLength(1);
  });

  test("a failed poll keeps the previous list and records the error", async () => {
    const { result } = await renderWithList([pendingRequest()]);

    listResponder = () =>
      jsonResponse({ error: { message: "Not available." } }, 503);
    await tickPoll();

    expect(result.current.requests).toEqual([pendingRequest()]);
    expect(result.current.error).toBe("Not available.");

    // The next successful poll clears the error again.
    serveList([pendingRequest()]);
    await tickPoll();
    expect(result.current.error).toBeNull();
  });
});

describe("usePendingPairingRequests: approve/deny", () => {
  test("approve tracks the in-flight action and removes the row on success", async () => {
    serveList([pendingRequest({ requestId: "req-1" }), pendingRequest({ requestId: "req-2" })]);
    let resolveApprove!: (response: Response) => void;
    installRoutedFetch({
      [APPROVE_URL]: () =>
        new Promise<Response>((resolve) => {
          resolveApprove = resolve;
        }),
    });

    let result!: ReturnType<typeof renderPendingRequests>["result"];
    await act(async () => {
      ({ result } = renderPendingRequests());
    });

    await act(async () => {
      void result.current.approve("req-1");
    });
    expect(result.current.actingOn).toEqual({
      requestId: "req-1",
      action: "approve",
    });

    await act(async () => {
      resolveApprove(approvedResponse());
    });

    const approveCalls = fetchLog.filter((r) => r.url === APPROVE_URL);
    expect(approveCalls).toHaveLength(1);
    expect(JSON.parse(approveCalls[0]?.init?.body as string)).toEqual({
      requestId: "req-1",
    });
    expect(result.current.actingOn).toBeNull();
    expect(result.current.requests.map((r) => r.requestId)).toEqual(["req-2"]);
    expect(result.current.error).toBeNull();
  });

  test("deny removes the row and clears the in-flight marker", async () => {
    serveList([pendingRequest({ requestId: "req-1" })]);
    installRoutedFetch({
      [DENY_URL]: () => jsonResponse({ status: "denied" }),
    });

    let result!: ReturnType<typeof renderPendingRequests>["result"];
    await act(async () => {
      ({ result } = renderPendingRequests());
    });

    await act(async () => {
      await result.current.deny("req-1");
    });

    expect(fetchLog.filter((r) => r.url === DENY_URL)).toHaveLength(1);
    expect(result.current.actingOn).toBeNull();
    expect(result.current.requests).toEqual([]);
  });

  test("a 404 from approve is treated as removal, not an error", async () => {
    serveList([pendingRequest({ requestId: "req-1" })]);
    installRoutedFetch({
      [APPROVE_URL]: () =>
        jsonResponse({ error: { message: "Unknown request." } }, 404),
    });

    let result!: ReturnType<typeof renderPendingRequests>["result"];
    await act(async () => {
      ({ result } = renderPendingRequests());
    });

    await act(async () => {
      await result.current.approve("req-1");
    });

    expect(result.current.requests).toEqual([]);
    expect(result.current.actingOn).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test("a non-404 failure keeps the row and surfaces the message", async () => {
    serveList([pendingRequest({ requestId: "req-1" })]);
    let approveResponder = () =>
      jsonResponse({ error: { message: "Approval failed." } }, 500);
    installRoutedFetch({ [APPROVE_URL]: () => approveResponder() });

    let result!: ReturnType<typeof renderPendingRequests>["result"];
    await act(async () => {
      ({ result } = renderPendingRequests());
    });

    await act(async () => {
      await result.current.approve("req-1");
    });

    expect(result.current.requests).toEqual([pendingRequest({ requestId: "req-1" })]);
    expect(result.current.actingOn).toBeNull();
    expect(result.current.error).toBe("Approval failed.");

    // Retrying clears the stale message before the new outcome lands.
    approveResponder = approvedResponse;
    await act(async () => {
      await result.current.approve("req-1");
    });
    expect(result.current.requests).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  test("a poll clears an action error once its request leaves the list", async () => {
    serveList([pendingRequest({ requestId: "req-1" })]);
    installRoutedFetch({
      [APPROVE_URL]: () =>
        jsonResponse({ error: { message: "Approval failed." } }, 500),
    });

    let result!: ReturnType<typeof renderPendingRequests>["result"];
    await act(async () => {
      ({ result } = renderPendingRequests());
    });

    await act(async () => {
      await result.current.approve("req-1");
    });
    expect(result.current.error).toBe("Approval failed.");

    // While the request is still listed, the error survives polls.
    await tickPoll();
    expect(result.current.requests.map((r) => r.requestId)).toEqual(["req-1"]);
    expect(result.current.error).toBe("Approval failed.");

    // Handled elsewhere or expired: the next poll drops the row and the error.
    serveList([]);
    await tickPoll();
    expect(result.current.requests).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  test("a base change clears rows and errors before the new base's poll resolves", async () => {
    serveList([pendingRequest({ requestId: "req-1" })]);
    // The new base's list never resolves, so anything shown for it is stale.
    installRoutedFetch({
      [OTHER_LIST_URL]: () => new Promise<Response>(() => {}),
    });

    let result!: ReturnType<typeof renderPendingRequests>["result"];
    let rerender!: ReturnType<typeof renderPendingRequests>["rerender"];
    await act(async () => {
      ({ result, rerender } = renderPendingRequests());
    });
    expect(result.current.requests).toHaveLength(1);

    // Put both error channels in a non-null state first.
    listResponder = () =>
      jsonResponse({ error: { message: "Not available." } }, 503);
    await tickPoll();
    expect(result.current.error).toBe("Not available.");

    await act(async () => {
      rerender({ base: OTHER_BASE });
    });

    expect(result.current.requests).toEqual([]);
    expect(result.current.error).toBeNull();
    // The new base was polled, but its hung response left the list empty.
    const otherListCalls = fetchLog.filter((r) => r.url === OTHER_LIST_URL);
    expect(otherListCalls).toHaveLength(1);
  });

  test("a base change aborts the pending action and frees the guard for the new base", async () => {
    serveList([pendingRequest({ requestId: "req-1" })]);
    let resolveOldApprove!: (response: Response) => void;
    installRoutedFetch({
      [APPROVE_URL]: () =>
        new Promise<Response>((resolve) => {
          resolveOldApprove = resolve;
        }),
      [OTHER_LIST_URL]: () =>
        jsonResponse({ requests: [pendingRequest({ requestId: "req-9" })] }),
      [OTHER_APPROVE_URL]: approvedResponse,
    });

    let result!: ReturnType<typeof renderPendingRequests>["result"];
    let rerender!: ReturnType<typeof renderPendingRequests>["rerender"];
    await act(async () => {
      ({ result, rerender } = renderPendingRequests());
    });

    await act(async () => {
      void result.current.approve("req-1");
    });
    expect(result.current.actingOn).toEqual({
      requestId: "req-1",
      action: "approve",
    });

    await act(async () => {
      rerender({ base: OTHER_BASE });
    });

    // The old action was aborted and its marker cleared.
    const oldApprove = fetchLog.filter((r) => r.url === APPROVE_URL);
    expect(oldApprove[0]?.init?.signal?.aborted).toBe(true);
    expect(result.current.actingOn).toBeNull();
    expect(result.current.requests.map((r) => r.requestId)).toEqual(["req-9"]);

    // A late success from the old base must not touch the new base's list.
    await act(async () => {
      resolveOldApprove(approvedResponse());
    });
    expect(result.current.requests.map((r) => r.requestId)).toEqual(["req-9"]);

    // The guard is free: an action against the new base goes through.
    await act(async () => {
      await result.current.approve("req-9");
    });
    expect(fetchLog.filter((r) => r.url === OTHER_APPROVE_URL)).toHaveLength(1);
    expect(result.current.requests).toEqual([]);
    expect(result.current.error).toBeNull();
  });

});

describe("usePendingPairingRequests: deny racing an approve", () => {
  const ALREADY_APPROVED_CONFLICT = () =>
    jsonResponse(
      {
        error: {
          code: "ALREADY_APPROVED",
          message: "Request already approved on another surface.",
        },
      },
      409,
    );

  test("a deny rejected with 409 ALREADY_APPROVED removes the row but surfaces the notice", async () => {
    serveList([pendingRequest({ requestId: "req-1" })]);
    installRoutedFetch({ [DENY_URL]: ALREADY_APPROVED_CONFLICT });

    let result!: ReturnType<typeof renderPendingRequests>["result"];
    await act(async () => {
      ({ result } = renderPendingRequests());
    });

    await act(async () => {
      await result.current.deny("req-1");
    });

    // The row is gone (it is no longer pending), but the user must learn the
    // deny never took effect and the device is now paired.
    expect(result.current.requests).toEqual([]);
    expect(result.current.actingOn).toBeNull();
    expect(result.current.error).toBe(
      "This request was already approved somewhere else, so the deny didn't take effect and the device is now paired.",
    );
  });

  test("the already-approved notice survives polls, then clears on the next action", async () => {
    serveList([pendingRequest({ requestId: "req-1" })]);
    installRoutedFetch({
      [DENY_URL]: ALREADY_APPROVED_CONFLICT,
      [APPROVE_URL]: approvedResponse,
    });

    let result!: ReturnType<typeof renderPendingRequests>["result"];
    await act(async () => {
      ({ result } = renderPendingRequests());
    });
    await act(async () => {
      await result.current.deny("req-1");
    });

    // Unlike ordinary action errors, the notice is not dropped when a poll no
    // longer lists the request; it would otherwise flash away within 5s.
    serveList([]);
    await tickPoll();
    expect(result.current.requests).toEqual([]);
    expect(result.current.error).toBe(
      "This request was already approved somewhere else, so the deny didn't take effect and the device is now paired.",
    );

    // A later request showing up and being acted on clears the stale notice.
    serveList([pendingRequest({ requestId: "req-2" })]);
    await tickPoll();
    await act(async () => {
      await result.current.approve("req-2");
    });
    expect(result.current.error).toBeNull();
  });

  test("a 409 on approve is not treated as handled elsewhere", async () => {
    serveList([pendingRequest({ requestId: "req-1" })]);
    installRoutedFetch({ [APPROVE_URL]: ALREADY_APPROVED_CONFLICT });

    let result!: ReturnType<typeof renderPendingRequests>["result"];
    await act(async () => {
      ({ result } = renderPendingRequests());
    });

    await act(async () => {
      await result.current.approve("req-1");
    });

    // The row stays with the server's message; the next poll reconciles it.
    expect(result.current.requests.map((r) => r.requestId)).toEqual(["req-1"]);
    expect(result.current.error).toBe(
      "Request already approved on another surface.",
    );
  });

  test("a deny rejected with a plain 409 (no code) keeps the row and shows the message", async () => {
    serveList([pendingRequest({ requestId: "req-1" })]);
    installRoutedFetch({
      [DENY_URL]: () =>
        jsonResponse({ error: { message: "Conflicting request." } }, 409),
    });

    let result!: ReturnType<typeof renderPendingRequests>["result"];
    await act(async () => {
      ({ result } = renderPendingRequests());
    });

    await act(async () => {
      await result.current.deny("req-1");
    });

    expect(result.current.requests.map((r) => r.requestId)).toEqual(["req-1"]);
    expect(result.current.error).toBe("Conflicting request.");
  });
});
