/**
 * Dedupe guard for concurrent managed-OAuth connects (JARVIS-1286).
 *
 * In voice mode the `oauth_connect` card remounts as the transcript re-renders,
 * resetting its per-instance `"connecting"` guard. Without a cross-instance
 * guard a second trigger opened a second popup and stranded the first behind a
 * `requestId` that never completed. `connectManagedOAuthProvider` reuses the
 * in-flight promise for the same assistant + provider so only one popup opens.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { oauthCompletionStorageKey } from "@/lib/auth/oauth-popup";

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsOauthStartCreate: mock(async () => ({
    data: {
      connect_url:
        "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x&redirect_uri=y",
    },
    error: null,
    response: new Response(),
  })),
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
});
