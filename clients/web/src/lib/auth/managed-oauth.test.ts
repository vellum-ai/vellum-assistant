/**
 * Dedupe guard for concurrent managed-OAuth connects (JARVIS-1286).
 *
 * In voice mode the `oauth_connect` card remounts as the transcript re-renders,
 * resetting its per-instance `"connecting"` guard. Without a cross-instance
 * guard a second trigger opened a second popup and stranded the first behind a
 * `requestId` that never completed. `connectManagedOAuthProvider` reuses the
 * in-flight promise for the same assistant + provider + scope set so only one
 * popup opens, and rejects a mismatched-scope request while another flow for
 * the provider is in flight (completion detection is provider-scoped).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { assistantsOauthStartCreate } from "@/generated/api/sdk.gen";
import { oauthCompletionStorageKey } from "@/lib/auth/oauth-popup";

const startCreateMock = mock(
  async (_options: Parameters<typeof assistantsOauthStartCreate>[0]) => ({
    data: {
      connect_url:
        "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x&redirect_uri=y",
    },
    error: null,
    response: new Response(),
  }),
);

/** Mutable backing store for the connections endpoint the poll path reads. */
let connectionRows: unknown[] = [];
/** Make the connections endpoint fail, as a transient outage would. */
let connectionsListFails = false;
/** Delay each connections response, to exercise races against the deadline. */
let connectionsListDelayMs = 0;

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsOauthStartCreate: startCreateMock,
  assistantsOauthConnectionsList: mock(async () => {
    if (connectionsListDelayMs > 0) {
      await new Promise((r) => setTimeout(r, connectionsListDelayMs));
    }
    if (connectionsListFails) {
      return {
        data: undefined,
        error: { detail: "boom" },
        response: new Response(),
      };
    }
    return { data: connectionRows, error: null, response: new Response() };
  }),
}));

const actualWatcher = await import("@/lib/auth/oauth-popup-watcher");

/**
 * Shrink the detached completion window for a single test. Re-mocking is what
 * refreshes the engine's live binding; bun snapshots a mocked module's values
 * at definition time, so a mutable getter is silently ignored.
 */
function setUnobservableWindowMs(ms: number): void {
  mock.module("@/lib/auth/oauth-popup-watcher", () => ({
    ...actualWatcher,
    UNOBSERVABLE_COMPLETION_WINDOW_MS: ms,
  }));
}
setUnobservableWindowMs(actualWatcher.UNOBSERVABLE_COMPLETION_WINDOW_MS);
mock.module("@/generated/daemon/sdk.gen", () => ({
  oauthProvidersGet: mock(async () => ({
    data: { providers: [] },
    error: null,
  })),
}));
mock.module("@/lib/local-platform-identity", () => ({
  resolveLocalAssistantPlatformIdentity: mock(async (id: string) => id),
}));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
}));
mock.module("@/runtime/browser", () => ({
  openUrl: async () => {},
  openUrlFinishedListener: () => () => {},
}));
// Collapse the connection-poll backoff; these tests exercise the decision
// logic, not the 750ms spacing between polls.
const actualConnectionUtils = await import("@/utils/oauth-connection-utils");
mock.module("@/utils/oauth-connection-utils", () => ({
  ...actualConnectionUtils,
  wait: async () => {},
}));

const { connectManagedOAuthProvider } = await import("./managed-oauth");

interface StubPopup {
  closed: boolean;
  close: () => void;
  location: { href: string };
}

const OPTS = {
  assistantId: "assistant-1",
  providerKey: "google",
  providerLabel: "Gmail",
};

let openSpy: ReturnType<typeof mock>;
let requestIds: string[];

/**
 * `connectManagedOAuthProvider` mints its own `requestId` via
 * `crypto.randomUUID`; stub it to a predictable sequence so tests can settle a
 * specific in-flight connect via its `storage` completion channel.
 */
beforeEach(() => {
  startCreateMock.mockClear();
  connectionRows = [];
  connectionsListFails = false;
  connectionsListDelayMs = 0;
  setUnobservableWindowMs(actualWatcher.UNOBSERVABLE_COMPLETION_WINDOW_MS);
  requestIds = [];
  let counter = 0;
  globalThis.crypto.randomUUID = (() => {
    const id = `req-${++counter}`;
    requestIds.push(id);
    return id;
  }) as typeof crypto.randomUUID;

  openSpy = mock((): StubPopup => {
    const popup: StubPopup = {
      closed: false,
      close: () => {
        popup.closed = true;
      },
      location: { href: "" },
    };
    return popup;
  });
  window.open = openSpy as unknown as typeof window.open;
});

/**
 * Flush microtasks until the start endpoint has been invoked `count` times:
 * the connect flow awaits identity resolution and a connections baseline
 * first.
 */
async function waitForStartCalls(count: number): Promise<void> {
  for (
    let i = 0;
    i < 100 && startCreateMock.mock.calls.length < count;
    i += 1
  ) {
    await Promise.resolve();
  }
  expect(startCreateMock).toHaveBeenCalledTimes(count);
}

async function waitForStartCall(): Promise<void> {
  await waitForStartCalls(1);
}

/** Settle an in-flight connect through the localStorage completion channel. */
function settleConnected(requestId: string): void {
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: oauthCompletionStorageKey(requestId),
      newValue: JSON.stringify({
        type: "vellum:oauth-complete",
        requestId,
        oauthStatus: "connected",
      }),
    }),
  );
}

/** Settle an in-flight connect through the localStorage completion channel. */
function settleFailed(requestId: string): void {
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: oauthCompletionStorageKey(requestId),
      newValue: JSON.stringify({
        type: "vellum:oauth-complete",
        requestId,
        oauthStatus: "error",
        oauthCode: "access_denied",
      }),
    }),
  );
}

describe("connectManagedOAuthProvider dedupe", () => {
  test("concurrent connects for the same provider share one popup", async () => {
    const first = connectManagedOAuthProvider(OPTS);
    const second = connectManagedOAuthProvider(OPTS);

    // Same in-flight promise, and only one popup opened.
    expect(second).toBe(first);
    expect(openSpy).toHaveBeenCalledTimes(1);

    // Completing the single flow resolves every waiting caller.
    settleFailed(requestIds[0]!);
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe("error");
    expect(b.status).toBe("error");
  });

  test("different providers open independent popups", async () => {
    const google = connectManagedOAuthProvider(OPTS);
    const slack = connectManagedOAuthProvider({
      ...OPTS,
      providerKey: "slack",
      providerLabel: "Slack",
    });

    expect(slack).not.toBe(google);
    expect(openSpy).toHaveBeenCalledTimes(2);

    settleFailed(requestIds[0]!);
    settleFailed(requestIds[1]!);
    await Promise.all([google, slack]);
  });

  test("a fresh connect opens a new popup once the prior one settled", async () => {
    const first = connectManagedOAuthProvider(OPTS);
    expect(openSpy).toHaveBeenCalledTimes(1);
    settleFailed(requestIds[0]!);
    await first;

    // The guard cleared on settle, so the next connect is a brand-new flow.
    const second = connectManagedOAuthProvider(OPTS);
    expect(second).not.toBe(first);
    expect(openSpy).toHaveBeenCalledTimes(2);
    settleFailed(requestIds[1]!);
    await second;
  });

  test("concurrent connects with the same scopes in any order share one flow", async () => {
    const first = connectManagedOAuthProvider({
      ...OPTS,
      requestedScopes: ["scope-a", "scope-b"],
    });
    const second = connectManagedOAuthProvider({
      ...OPTS,
      requestedScopes: ["scope-b", "scope-a"],
    });

    expect(second).toBe(first);
    expect(openSpy).toHaveBeenCalledTimes(1);
    await waitForStartCall();

    settleFailed(requestIds[0]!);
    await Promise.all([first, second]);
  });

  test("a concurrent connect with different scopes is rejected", async () => {
    const first = connectManagedOAuthProvider({
      ...OPTS,
      requestedScopes: ["scope-a"],
    });
    const second = connectManagedOAuthProvider({
      ...OPTS,
      requestedScopes: ["scope-a", "scope-b"],
    });

    // The mismatched request is rejected without starting a flow or popup.
    const rejected = await second;
    expect(rejected.status).toBe("error");
    expect(openSpy).toHaveBeenCalledTimes(1);
    await waitForStartCalls(1);
    expect(startCreateMock.mock.calls[0]?.[0].body?.requested_scopes).toEqual([
      "scope-a",
    ]);

    // The original flow is untouched and still completable.
    settleFailed(requestIds[0]!);
    const result = await first;
    expect(result.status).toBe("error");
  });

  test("a connect with different scopes proceeds once the prior flow settled", async () => {
    const first = connectManagedOAuthProvider({
      ...OPTS,
      requestedScopes: ["scope-a"],
    });
    await waitForStartCalls(1);
    settleFailed(requestIds[0]!);
    await first;

    const second = connectManagedOAuthProvider({
      ...OPTS,
      requestedScopes: ["scope-a", "scope-b"],
    });
    expect(openSpy).toHaveBeenCalledTimes(2);
    await waitForStartCalls(2);
    expect(startCreateMock.mock.calls[1]?.[0].body?.requested_scopes).toEqual([
      "scope-a",
      "scope-b",
    ]);

    settleFailed(requestIds[1]!);
    await second;
  });

  test("undefined and empty requestedScopes normalize to the same flow", async () => {
    const first = connectManagedOAuthProvider(OPTS);
    const second = connectManagedOAuthProvider({
      ...OPTS,
      requestedScopes: [],
    });

    expect(second).toBe(first);
    expect(openSpy).toHaveBeenCalledTimes(1);

    settleFailed(requestIds[0]!);
    await Promise.all([first, second]);
  });
});

describe("connectManagedOAuthProvider requested scopes", () => {
  test("requestedScopes are sent as requested_scopes in the start body", async () => {
    const requestedScopes = [
      "https://www.googleapis.com/auth/tasks",
      "https://www.googleapis.com/auth/calendar",
    ];
    const connect = connectManagedOAuthProvider({ ...OPTS, requestedScopes });

    await waitForStartCall();
    expect(startCreateMock.mock.calls[0]?.[0].body?.requested_scopes).toEqual(
      requestedScopes,
    );

    settleFailed(requestIds[0]!);
    await connect;
  });

  test("omitting requestedScopes sends an empty requested_scopes array", async () => {
    const connect = connectManagedOAuthProvider(OPTS);

    await waitForStartCall();
    expect(startCreateMock.mock.calls[0]?.[0].body?.requested_scopes).toEqual(
      [],
    );

    settleFailed(requestIds[0]!);
    await connect;
  });
});

/**
 * The COOP regression (Link by Stripe).
 *
 * `link.com` serves `Cross-Origin-Opener-Policy: same-origin` and
 * `connect.stripe.com` serves `same-origin-allow-popups`. Navigating the popup
 * onto either one moves it into a new browsing-context group and disowns our
 * handle, so `popup.closed` flips to `true` within a few hundred ms while the
 * window is still open on the "Confirm it's you" step. Treating that as a
 * cancellation produced a red "authorization popup closed" toast mid-flow and,
 * worse, tore down the completion listeners so the authorization the user went
 * on to finish was never reported.
 */
describe("connectManagedOAuthProvider with a COOP-disowned popup", () => {
  /** Let the 100ms poll observe the handle and the 1s grace elapse. */
  const afterPopupLostGrace = () => new Promise((r) => setTimeout(r, 1400));

  const connectedRow = {
    id: "conn-1",
    provider: "google",
    connected: true,
    status: "connected",
    account_label: "user@example.com",
    scopes_granted: ["scope-a"],
    expires_at: null,
  };

  test("does not resolve as cancelled while the popup is still open", async () => {
    const connect = connectManagedOAuthProvider(OPTS);
    let settled: unknown = null;
    void connect.then((r) => {
      settled = r;
    });
    await waitForStartCall();

    // What COOP does: the handle reads closed, the window is still up.
    const popup = openSpy.mock.results[0]?.value as StubPopup;
    popup.closed = true;
    await afterPopupLostGrace();

    expect(settled).toBeNull();

    // The user finishes the flow in the popup we could no longer see.
    connectionRows = [connectedRow];
    settleConnected(requestIds[0]!);
    const result = await connect;
    expect(result.status).toBe("connected");
  });

  test("releases the dedupe slot so a retry opens a new popup", async () => {
    const first = connectManagedOAuthProvider(OPTS);
    await waitForStartCall();
    const popup = openSpy.mock.results[0]?.value as StubPopup;
    popup.closed = true;
    await afterPopupLostGrace();

    // Detached, so the next connect is a real second flow rather than a
    // silent no-op that hands back the unobservable one.
    const second = connectManagedOAuthProvider(OPTS);
    expect(second).not.toBe(first);
    expect(openSpy).toHaveBeenCalledTimes(2);

    settleFailed(requestIds[1]!);
    await second;
    settleFailed(requestIds[0]!);
    await first;
  });

  test("a popup closed before the hand-off is still reported as cancelled", async () => {
    // No COOP response can have applied yet, so `closed` is trustworthy here.
    startCreateMock.mockImplementationOnce(
      () => new Promise(() => {}) as never,
    );
    const connect = connectManagedOAuthProvider(OPTS);
    await Promise.resolve();
    const popup = openSpy.mock.results[0]?.value as StubPopup;
    popup.closed = true;

    const result = await connect;
    expect(result).toEqual({ status: "cancelled", reason: "popup-closed" });
  });
});

/** Review follow-ups on the detached-flow contract (PR #42296). */
describe("connectManagedOAuthProvider detached-flow contract", () => {
  const afterPopupLostGrace = () => new Promise((r) => setTimeout(r, 1400));

  const connectedRow = {
    id: "conn-1",
    provider: "google",
    connected: true,
    status: "connected",
    account_label: "user@example.com",
    scopes_granted: ["scope-a"],
    expires_at: null,
  };

  test("detach notifies callers that joined the shared flow, not just the starter", async () => {
    let starterNotified = false;
    let joinerNotified = false;

    const first = connectManagedOAuthProvider({
      ...OPTS,
      onDetached: () => {
        starterNotified = true;
      },
    });
    await waitForStartCall();

    // A remount (or a second entry point) latches onto the same flow, and is
    // showing a busy state of its own.
    const second = connectManagedOAuthProvider({
      ...OPTS,
      onDetached: () => {
        joinerNotified = true;
      },
    });
    expect(second).toBe(first);

    const popup = openSpy.mock.results[0]?.value as StubPopup;
    popup.closed = true;
    await afterPopupLostGrace();

    expect(starterNotified).toBe(true);
    expect(joinerNotified).toBe(true);

    settleFailed(requestIds[0]!);
    await first;
  });

  test("a failed baseline fetch never reports an existing account as newly connected", async () => {
    // The user already has this provider connected, and the pre-authorization
    // snapshot fails. Without a baseline the existing row looks new, which
    // would report a cancelled connect as a success.
    connectionsListFails = true;
    const connect = connectManagedOAuthProvider(OPTS);
    await waitForStartCall();

    connectionsListFails = false;
    connectionRows = [connectedRow];

    const popup = openSpy.mock.results[0]?.value as StubPopup;
    popup.closed = true;
    await afterPopupLostGrace();

    // Detached rather than falsely connected, so it can still settle on its
    // own completion payload.
    settleFailed(requestIds[0]!);
    const result = await connect;
    expect(result.status).not.toBe("connected");
  });

  test("a completion accepted near the deadline is not lost to a timeout", async () => {
    // Long enough to survive the reconcile that runs when the popup is lost,
    // short enough that the slow row lookup below outlasts it.
    setUnobservableWindowMs(600);
    const connect = connectManagedOAuthProvider(OPTS);
    await waitForStartCall();

    const popup = openSpy.mock.results[0]?.value as StubPopup;
    popup.closed = true;
    await afterPopupLostGrace();

    // The completion lands, but looking up the row outlasts the window. The
    // payload has to disarm the deadline rather than race the poll.
    connectionRows = [connectedRow];
    connectionsListDelayMs = 900;
    settleConnected(requestIds[0]!);

    const result = await connect;
    expect(result.status).toBe("connected");
  });

  test("a completion during the lost-popup poll wins, with no late detach", async () => {
    // The reconcile poll is slow, and an authorization failure lands while it
    // is still retrying. The flow is already settled by the time the poll
    // returns, so it must not go on to detach: that would reset a card which
    // is showing the error, and leave a stray deadline behind.
    let detached = false;
    const connect = connectManagedOAuthProvider({
      ...OPTS,
      onDetached: () => {
        detached = true;
      },
    });
    await waitForStartCall();

    // Slow only the reconcile poll, not the baseline fetch above it. Eight
    // attempts at 100ms keeps the poll in flight past the completion below.
    connectionsListDelayMs = 100;
    const popup = openSpy.mock.results[0]?.value as StubPopup;
    popup.closed = true;
    await new Promise((r) => setTimeout(r, 1400));
    settleFailed(requestIds[0]!);

    const result = await connect;
    expect(result.status).toBe("error");
    // Outlast the poll, so a late detach would have landed by now.
    await new Promise((r) => setTimeout(r, 1600));
    expect(detached).toBe(false);
  });

  test("a connected payload during the lost-popup poll blocks a late detach", async () => {
    // `connected` reconciles asynchronously, so `settled` is still false while
    // the lost-popup poll finishes. The flow must not detach underneath an
    // authorization that already succeeded.
    let detached = false;
    const connect = connectManagedOAuthProvider({
      ...OPTS,
      onDetached: () => {
        detached = true;
      },
    });
    await waitForStartCall();

    connectionsListDelayMs = 100;
    const popup = openSpy.mock.results[0]?.value as StubPopup;
    popup.closed = true;
    await new Promise((r) => setTimeout(r, 1400));

    settleConnected(requestIds[0]!);
    // The row lands only after the lost-popup poll has given up, so that poll
    // reaches the detach branch with the completion already accepted.
    setTimeout(() => {
      connectionRows = [connectedRow];
    }, 600);

    const result = await connect;
    expect(result.status).toBe("connected");
    await new Promise((r) => setTimeout(r, 1600));
    expect(detached).toBe(false);
  });

  test("a detached flow that never completes resolves as timed out", async () => {
    setUnobservableWindowMs(300);
    const connect = connectManagedOAuthProvider(OPTS);
    await waitForStartCall();

    const popup = openSpy.mock.results[0]?.value as StubPopup;
    popup.closed = true;

    const result = await connect;
    expect(result).toEqual({ status: "cancelled", reason: "timed-out" });
  });
});
