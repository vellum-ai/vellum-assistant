/**
 * Tests for `deletePushTokenBestEffort` — APNs logout DELETE wiring.
 *
 * The DELETE is best-effort: any HTTP failure must be swallowed so that
 * `auth.tsx`'s logout flow can never be blocked by a transient platform
 * error. Whatever happens, the registration latch in `pushState` must be
 * empty when the function returns.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// `mock.module` in bun is process-global: a factory that returns only
// `{ assistantsPushTokensDelete }` would clobber every other export on
// `@/clients/platform` for any test file that runs in the same `bun test`
// process (chat API tests, etc.). Snapshot the real module here so we can
// spread it in the factory and only override the symbol we mock.
import * as realInternalClient from "@/generated/api/sdk.gen.js";
const REAL_INTERNAL_CLIENT: Record<string, unknown> = { ...realInternalClient };

type DeleteResult = { data: undefined; response: Response };
type DeleteOptions = {
  client: unknown;
  path: { assistant_id: string; token: string };
  query: { bundle_id: string };
  throwOnError: boolean;
};

const mockDelete = mock(
  (_options: DeleteOptions): Promise<DeleteResult> =>
    Promise.resolve({ data: undefined, response: new Response() }),
);

// `@/lib/vellum-api/client` is a side-effect-only module (no named
// exports consumed by the codebase), so an empty mock is safe and avoids
// registering csrf/org-id interceptors during tests.
mock.module("@/lib/vellum-api/client.js", () => ({}));

// Spread the real heyapi barrel so other test files that share this
// process keep working. Only override `assistantsPushTokensDelete`.
mock.module("@/clients/platform/index.js", () => ({
  ...REAL_INTERNAL_CLIENT,
  assistantsPushTokensDelete: (options: DeleteOptions) => mockDelete(options),
}));

mock.module("@sentry/react", () => ({
  captureException: mock(() => {}),
}));

// Subject + state import after mocks.
import { deletePushTokenBestEffort } from "@/lib/push/unregister.js";
import { __resetPushStateForTests, pushState } from "@/lib/push/state.js";

const ASSISTANT_ID = "asst_01H0000000000000000000";
const BUNDLE_ID = "ai.vocify-inc.vellum-assistant-ios";
const TOKEN = "ios-device-token-abc";

function seedPushState(): void {
  pushState.currentToken = TOKEN;
  pushState.currentBundleId = BUNDLE_ID;
  pushState.currentApnsEnvironment = "production";
  pushState.currentAssistantId = ASSISTANT_ID;
}

function expectStateCleared(): void {
  expect(pushState.currentToken).toBeNull();
  expect(pushState.currentBundleId).toBeNull();
  expect(pushState.currentApnsEnvironment).toBeNull();
  expect(pushState.currentAssistantId).toBeNull();
}

beforeEach(() => {
  mockDelete.mockClear();
  mockDelete.mockImplementation(() =>
    Promise.resolve({ data: undefined, response: new Response() }),
  );
  __resetPushStateForTests();
});

afterEach(() => {
  __resetPushStateForTests();
});

describe("deletePushTokenBestEffort — happy path", () => {
  test("calls DELETE with cached (assistant, token, bundle) and clears state", async () => {
    seedPushState();

    await deletePushTokenBestEffort();

    expect(mockDelete).toHaveBeenCalledTimes(1);
    const call = mockDelete.mock.calls[0]?.[0] as DeleteOptions;
    expect(call).toBeDefined();
    expect(call.path.assistant_id).toBe(ASSISTANT_ID);
    expect(call.path.token).toBe(TOKEN);
    expect(call.query.bundle_id).toBe(BUNDLE_ID);
    expect(call.throwOnError).toBe(true);

    expectStateCleared();
  });
});

describe("deletePushTokenBestEffort — failure swallowed", () => {
  test("HTTP error: no throw, state still cleared", async () => {
    mockDelete.mockImplementation(() =>
      Promise.reject(new Error("503 platform unreachable")),
    );
    seedPushState();

    await expect(deletePushTokenBestEffort()).resolves.toBeUndefined();
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expectStateCleared();
  });

  test("network error: no throw, state still cleared", async () => {
    mockDelete.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));
    seedPushState();

    await expect(deletePushTokenBestEffort()).resolves.toBeUndefined();
    expectStateCleared();
  });
});

describe("deletePushTokenBestEffort — no-op guards", () => {
  test("no cached token: no DELETE call, state already clear stays clear", async () => {
    // pushState defaults to all-null after reset.
    await deletePushTokenBestEffort();

    expect(mockDelete).toHaveBeenCalledTimes(0);
    expectStateCleared();
  });

  test("missing bundle_id: no DELETE call, defensive flush still runs", async () => {
    pushState.currentToken = TOKEN;
    pushState.currentAssistantId = ASSISTANT_ID;
    // Intentionally leave currentBundleId null.

    await deletePushTokenBestEffort();

    expect(mockDelete).toHaveBeenCalledTimes(0);
    expectStateCleared();
  });

  test("missing assistant_id: no DELETE call, defensive flush still runs", async () => {
    pushState.currentToken = TOKEN;
    pushState.currentBundleId = BUNDLE_ID;
    // Intentionally leave currentAssistantId null.

    await deletePushTokenBestEffort();

    expect(mockDelete).toHaveBeenCalledTimes(0);
    expectStateCleared();
  });
});

describe("deletePushTokenBestEffort — idempotency", () => {
  test("two sequential calls: second is a no-op (no DELETE, state stays clear)", async () => {
    seedPushState();

    await deletePushTokenBestEffort();
    expect(mockDelete).toHaveBeenCalledTimes(1);

    await deletePushTokenBestEffort();
    expect(mockDelete).toHaveBeenCalledTimes(1); // still 1 — second no-ops
    expectStateCleared();
  });
});
