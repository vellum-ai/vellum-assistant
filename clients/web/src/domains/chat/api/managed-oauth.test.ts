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

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsOauthStartCreate: startCreateMock,
  assistantsOauthConnectionsList: mock(async () => ({
    data: [],
    error: null,
    response: new Response(),
  })),
}));
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
  for (let i = 0; i < 100 && startCreateMock.mock.calls.length < count; i += 1) {
    await Promise.resolve();
  }
  expect(startCreateMock).toHaveBeenCalledTimes(count);
}

async function waitForStartCall(): Promise<void> {
  await waitForStartCalls(1);
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
