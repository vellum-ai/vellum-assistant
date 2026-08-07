import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mutable mock state ────────────────────────────────────────────────

const secureKeyValues = new Map<string, string>();

// Webhook routing is driven through its real inputs rather than by mocking
// `hasWebhookRoutingConfigured` itself. Stubbing the predicate would have let
// the sweep and the predicate drift apart unnoticed, which is exactly how
// LUM-2882 stayed invisible: the predicate stopped matching what
// `webhooks register` actually does for platform-connected local assistants.
let ingressConfig: Record<string, unknown> = {};
let isPlatform = false;
let platformContextEnabled = false;

type FetchOutcome =
  | { kind: "json"; status?: number; body: unknown }
  | { kind: "throw"; message: string };

let fetchOutcome: FetchOutcome = {
  kind: "json",
  body: { ok: true, result: { url: "https://example.test/webhooks/telegram" } },
};
let fetchCallCount = 0;
const fetchedUrls: string[] = [];

const emittedSignals: Array<Record<string, unknown>> = [];
let emitFails = false;

// ── Module mocks ──────────────────────────────────────────────────────

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => secureKeyValues.get(account),
}));

mock.module("../../security/credential-key.js", () => ({
  credentialKey: (service: string, field: string) =>
    `credential/${service}/${field}`,
}));

mock.module("../bot-username.js", () => ({
  getTelegramBotUsername: () => "test_bot",
  getTelegramBotId: () => "123",
}));

let apiBaseUrl = "https://api.telegram.org";

// What the gateway reconciler recorded on its last successful setWebhook.
// Defaults to the URL the fixtures report from getWebhookInfo, so the common
// case is a verified match; tests override it to exercise a stale registration
// and a deployment that never recorded one.
let registeredWebhookUrl: string | undefined =
  "https://example.test/webhooks/telegram";

// Spread the real modules below: these are broad barrels shared with peer test
// files, and replacing one wholesale drops the exports those files import.
const actualLoader = await import("../../config/loader.js");
mock.module("../../config/loader.js", () => ({
  ...actualLoader,
  getConfig: () => ({
    telegram: { apiBaseUrl, registeredWebhookUrl },
    ingress: ingressConfig,
  }),
  loadRawConfig: () => ({ ingress: ingressConfig }),
}));

const actualEnvRegistry = await import("../../config/env-registry.js");
mock.module("../../config/env-registry.js", () => ({
  ...actualEnvRegistry,
  getIsPlatform: () => isPlatform,
}));

const actualRegistration =
  await import("../../inbound/platform-callback-registration.js");
mock.module("../../inbound/platform-callback-registration.js", () => ({
  ...actualRegistration,
  resolvePlatformCallbackRegistrationContext: async () => ({
    isPlatform,
    platformBaseUrl: "https://api.vellum.ai",
    assistantId: platformContextEnabled ? "assistant-123" : "",
    hasAssistantApiKey: platformContextEnabled,
    authHeader: platformContextEnabled ? "Api-Key secret" : null,
    enabled: platformContextEnabled,
  }),
}));

// Mirrors the real `emitNotificationSignal` contract: it swallows pipeline
// errors and resolves with `dispatched: false` UNLESS `throwOnError` is set.
// The mock reproduces that conditional rather than throwing unconditionally —
// otherwise it would validate a contract the real function does not have, and
// the caller's retry path could be dead in production while tests pass.
mock.module("../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    if (emitFails) {
      if (params.throwOnError) {
        throw new Error("emit failed");
      }
      return {
        signalId: "sig",
        deduplicated: false,
        dispatched: false,
        reason: "Signal pipeline failed: emit failed",
        deliveryResults: [],
      };
    }
    emittedSignals.push(params);
    return {
      signalId: "sig",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
    };
  },
}));

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string) => {
  fetchCallCount++;
  fetchedUrls.push(String(input));
  const outcome = fetchOutcome;
  if (outcome.kind === "throw") {
    throw new Error(outcome.message);
  }
  const status = outcome.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => outcome.body,
  } as Response;
}) as unknown as typeof fetch;

const {
  _resetTelegramWebhookHealthState,
  checkTelegramWebhookHealth,
  runTelegramWebhookHealthCheck,
} = await import("../webhook-health.js");

// ── Helpers ───────────────────────────────────────────────────────────

const BOT_TOKEN_KEY = "credential/telegram/bot_token";
const WEBHOOK_SECRET_KEY = "credential/telegram/webhook_secret";
const WEBHOOK_URL = "https://example.test/webhooks/telegram";

/** Unix seconds, `secondsAgo` in the past — Telegram reports seconds, not ms. */
function unixSecondsAgo(secondsAgo: number): number {
  return Math.floor((Date.now() - secondsAgo * 1000) / 1000);
}

function setWebhookInfo(result: Record<string, unknown>): void {
  fetchOutcome = { kind: "json", body: { ok: true, result } };
}

beforeEach(() => {
  secureKeyValues.clear();
  secureKeyValues.set(BOT_TOKEN_KEY, "12345:test-token");
  secureKeyValues.set(WEBHOOK_SECRET_KEY, "s3cret");
  ingressConfig = { publicBaseUrl: "https://example.test" };
  isPlatform = false;
  platformContextEnabled = false;
  setWebhookInfo({ url: WEBHOOK_URL, pending_update_count: 0 });
  fetchCallCount = 0;
  fetchedUrls.length = 0;
  apiBaseUrl = "https://api.telegram.org";
  registeredWebhookUrl = "https://example.test/webhooks/telegram";
  emittedSignals.length = 0;
  emitFails = false;
  _resetTelegramWebhookHealthState();
});

// ── Gating ────────────────────────────────────────────────────────────

describe("gating", () => {
  test("does not run when no Telegram bot token is configured", async () => {
    secureKeyValues.delete(BOT_TOKEN_KEY);

    const result = await runTelegramWebhookHealthCheck();

    expect(result.status).toBe("skipped");
    expect(fetchCallCount).toBe(0);
    expect(emittedSignals).toHaveLength(0);
  });

  test("does not run when the webhook secret is missing", async () => {
    // The gateway reconciler bails before setWebhook without the secret, so a
    // bot_token-only workspace has no webhook by design. Alerting here would
    // name the wrong cause and point at an ingress URL the user hasn't set yet.
    secureKeyValues.delete(WEBHOOK_SECRET_KEY);

    const result = await runTelegramWebhookHealthCheck();

    expect(result.status).toBe("skipped");
    expect(fetchCallCount).toBe(0);
    expect(emittedSignals).toHaveLength(0);
  });

  test("does not run when no webhook routing is configured", async () => {
    ingressConfig = {};

    const result = await runTelegramWebhookHealthCheck();

    expect(result.status).toBe("skipped");
    expect(fetchCallCount).toBe(0);
    expect(emittedSignals).toHaveLength(0);
  });

  test("does not run when public ingress is explicitly disabled", async () => {
    // An opt-out means no inbound webhook is expected at all, so the sweep has
    // nothing to verify even though platform credentials are present.
    ingressConfig = { enabled: false };
    platformContextEnabled = true;

    const result = await runTelegramWebhookHealthCheck();

    expect(result.status).toBe("skipped");
    expect(fetchCallCount).toBe(0);
    expect(emittedSignals).toHaveLength(0);
  });

  test("runs for a platform-connected local assistant with no ingress", async () => {
    // LUM-2882: `webhooks register telegram` registers a platform callback
    // route in this exact configuration, so a broken registration is real and
    // the sweep has to verify it rather than skip.
    ingressConfig = {};
    platformContextEnabled = true;
    setWebhookInfo({
      url: WEBHOOK_URL,
      last_error_date: unixSecondsAgo(30),
      last_error_message: "Wrong response from the webhook: 404 Not Found",
    });

    const result = await runTelegramWebhookHealthCheck();

    expect(result.status).toBe("delivery_failing");
    expect(fetchCallCount).toBeGreaterThan(0);
    expect(emittedSignals).toHaveLength(1);
    // The callback route is platform-owned, so the self-hosted remediation
    // (point config at a new tunnel URL) does not apply.
    expect(result.detail).not.toContain("assistant config set");
    expect(result.detail).toContain("contact support");
  });

  test("runs when platform-managed callbacks stand in for public ingress", async () => {
    isPlatform = true;
    ingressConfig = {};
    setWebhookInfo({
      url: WEBHOOK_URL,
      last_error_date: unixSecondsAgo(30),
      last_error_message: "Wrong response from the webhook: 404 Not Found",
    });

    const result = await runTelegramWebhookHealthCheck();

    expect(result.status).toBe("delivery_failing");
    expect(emittedSignals).toHaveLength(1);
    // Managed deployments can't set the ingress URL themselves, so the
    // self-hosted remediation must not be offered to them.
    expect(result.detail).not.toContain("assistant config set");
    expect(result.detail).toContain("contact support");
  });
});

// ── Detection ─────────────────────────────────────────────────────────

describe("detection", () => {
  test("a recent delivery error is a failure", async () => {
    setWebhookInfo({
      url: WEBHOOK_URL,
      pending_update_count: 3,
      last_error_date: unixSecondsAgo(60),
      last_error_message: "Wrong response from the webhook: 404 Not Found",
    });

    const result = await checkTelegramWebhookHealth();

    expect(result.status).toBe("delivery_failing");
    expect(result.pendingUpdateCount).toBe(3);
    expect(result.lastErrorMessage).toBe(
      "Wrong response from the webhook: 404 Not Found",
    );
  });

  test("a stale delivery error is not a failure", async () => {
    // Telegram never clears last_error_date, so an old error must not be read
    // as an ongoing outage — otherwise one historical blip alerts forever.
    setWebhookInfo({
      url: WEBHOOK_URL,
      pending_update_count: 0,
      last_error_date: unixSecondsAgo(7 * 24 * 60 * 60),
      last_error_message: "Wrong response from the webhook: 404 Not Found",
    });

    const result = await checkTelegramWebhookHealth();

    expect(result.status).toBe("healthy");
  });

  test("an empty webhook URL means the channel is dark", async () => {
    setWebhookInfo({ url: "", pending_update_count: 0 });

    const result = await checkTelegramWebhookHealth();

    expect(result.status).toBe("not_registered");
    expect(result.detail).toContain("no webhook registered");
  });

  test("an unreachable Telegram API yields unknown, not a failure", async () => {
    fetchOutcome = { kind: "throw", message: "network unreachable" };

    const result = await checkTelegramWebhookHealth();

    expect(result.status).toBe("unknown");
  });

  test("a non-2xx response yields unknown, not a failure", async () => {
    fetchOutcome = { kind: "json", status: 500, body: {} };

    const result = await checkTelegramWebhookHealth();

    expect(result.status).toBe("unknown");
  });

  test("an unexpected response shape yields unknown, not a failure", async () => {
    fetchOutcome = { kind: "json", body: { ok: false, description: "nope" } };

    const result = await checkTelegramWebhookHealth();

    expect(result.status).toBe("unknown");
  });

  test("reports url_mismatch when Telegram holds an address we did not register", async () => {
    // The quiet-channel case the module header names as a known limitation:
    // Telegram only produces delivery errors when it has something to deliver,
    // so a stale tunnel address never errors and, before this comparison, read
    // as healthy. No error is set here on purpose.
    registeredWebhookUrl = "https://current.test/webhooks/telegram";
    setWebhookInfo({
      url: "https://stale.test/webhooks/telegram",
      pending_update_count: 0,
    });

    const result = await checkTelegramWebhookHealth();

    expect(result.status).toBe("url_mismatch");
    expect(result.registeredUrl).toBe("https://stale.test/webhooks/telegram");
    expect(result.expectedUrl).toBe("https://current.test/webhooks/telegram");
  });

  test("reports url_mismatch ahead of a recent delivery error", async () => {
    // Both conditions hold. The mismatch is the cause and the error is its
    // symptom, and they have different fixes, so the mismatch must win.
    registeredWebhookUrl = "https://current.test/webhooks/telegram";
    setWebhookInfo({
      url: "https://stale.test/webhooks/telegram",
      pending_update_count: 3,
      last_error_date: Math.floor(Date.now() / 1000),
      last_error_message: "Connection refused",
    });

    expect((await checkTelegramWebhookHealth()).status).toBe("url_mismatch");
  });

  test("reports unverified when nothing recorded which URL we registered", async () => {
    // Reconciliation has not completed, or predates URL recording. Registered
    // and quiet, but unproven: this must not report healthy.
    registeredWebhookUrl = undefined;
    setWebhookInfo({
      url: "https://example.test/webhooks/telegram",
      pending_update_count: 0,
    });

    const result = await checkTelegramWebhookHealth();

    expect(result.status).toBe("unverified");
    expect(result.expectedUrl).toBeUndefined();
  });

  test("an unverified webhook does not alert the guardian", async () => {
    // Unproven is not broken. Alerting here would page every install whose
    // last reconciliation predates recording.
    registeredWebhookUrl = undefined;
    setWebhookInfo({
      url: "https://example.test/webhooks/telegram",
      pending_update_count: 0,
    });

    await runTelegramWebhookHealthCheck();

    expect(emittedSignals).toHaveLength(0);
  });

  test("honors a configured telegram.apiBaseUrl", async () => {
    apiBaseUrl = "https://telegram-proxy.internal/";

    await checkTelegramWebhookHealth();

    expect(fetchedUrls[0]).toBe(
      "https://telegram-proxy.internal/bot12345:test-token/getWebhookInfo",
    );
  });

  test("the detail names the channel and the reported error", async () => {
    setWebhookInfo({
      url: WEBHOOK_URL,
      pending_update_count: 3,
      last_error_date: unixSecondsAgo(60),
      last_error_message: "Wrong response from the webhook: 404 Not Found",
    });

    const result = await checkTelegramWebhookHealth();

    expect(result.detail).toContain("Telegram (@test_bot)");
    expect(result.detail).toContain(
      "Wrong response from the webhook: 404 Not Found",
    );
    expect(result.detail).toContain("3 update(s) are queued");
    expect(result.detail).toContain(
      "assistant config set ingress.publicBaseUrl",
    );
  });
});

// ── Alerting ──────────────────────────────────────────────────────────

describe("alerting", () => {
  function setFailing(
    message = "Wrong response from the webhook: 404 Not Found",
  ) {
    setWebhookInfo({
      url: WEBHOOK_URL,
      pending_update_count: 3,
      last_error_date: unixSecondsAgo(30),
      last_error_message: message,
    });
  }

  function setHealthy() {
    setWebhookInfo({ url: WEBHOOK_URL, pending_update_count: 0 });
  }

  test("a failing webhook notifies the guardian once", async () => {
    setFailing();

    await runTelegramWebhookHealthCheck();

    expect(emittedSignals).toHaveLength(1);
    const signal = emittedSignals[0]!;
    expect(signal.sourceEventName).toBe("telegram.webhook_health_alert");
    // Never routed as if it came from Telegram — that channel is the broken one.
    // "assistant_tool" specifically, because that plus requestedMessage is what
    // takes the decision engine's verbatim pass-through and skips the LLM
    // classifier. AGENTS.md forbids LLM work on unconditional timers, and a
    // classifier could also suppress the alert outright.
    expect(signal.sourceChannel).toBe("assistant_tool");
    // Pins the emitNotificationSignal contract: without this the pipeline
    // swallows failures and the latch-release retry path below is dead code.
    expect(signal.throwOnError).toBe(true);
    expect(signal.attentionHints).toMatchObject({
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: true,
    });

    const payload = signal.contextPayload as Record<string, unknown>;
    expect(payload.channel).toBe("telegram");
    expect(payload.status).toBe("delivery_failing");
    expect(payload.pendingUpdateCount).toBe(3);
    expect(String(payload.body)).toContain("Telegram (@test_bot)");
    expect(String(payload.body)).toContain("404 Not Found");
    // The pass-through reads requestedMessage/requestedTitle; the home-feed
    // writer reads body/title. Both must carry the composed copy or the alert
    // silently falls back to the LLM path (or renders empty).
    expect(payload.requestedMessage).toBe(payload.body);
    expect(payload.requestedTitle).toBe(payload.title);
    expect(String(payload.requestedMessage)).not.toHaveLength(0);
  });

  test("an unregistered webhook alerts with a title matching that status", async () => {
    setWebhookInfo({ url: "", pending_update_count: 0 });

    await runTelegramWebhookHealthCheck();

    expect(emittedSignals).toHaveLength(1);
    const payload = emittedSignals[0]!.contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.status).toBe("not_registered");
    expect(payload.title).toBe("Telegram webhook is not registered");
  });

  test("an ongoing failure does not re-alert on every poll", async () => {
    setFailing();

    await runTelegramWebhookHealthCheck();
    await runTelegramWebhookHealthCheck();
    await runTelegramWebhookHealthCheck();

    expect(emittedSignals).toHaveLength(1);
  });

  test("a changing error message mid-outage does not re-alert", async () => {
    setFailing("Wrong response from the webhook: 404 Not Found");
    await runTelegramWebhookHealthCheck();

    setFailing("Connection timed out");
    await runTelegramWebhookHealthCheck();

    expect(emittedSignals).toHaveLength(1);
  });

  test("a recovered webhook does not alert again", async () => {
    setFailing();
    await runTelegramWebhookHealthCheck();
    expect(emittedSignals).toHaveLength(1);

    setHealthy();
    await runTelegramWebhookHealthCheck();
    await runTelegramWebhookHealthCheck();

    // Recovery is silent — one alert total, and no "recovered" notification.
    expect(emittedSignals).toHaveLength(1);
  });

  test("a new outage after a recovery alerts again", async () => {
    setFailing();
    await runTelegramWebhookHealthCheck();

    setHealthy();
    await runTelegramWebhookHealthCheck();

    setFailing();
    await runTelegramWebhookHealthCheck();

    expect(emittedSignals).toHaveLength(2);
    // Distinct dedupe keys, or the pipeline would swallow the second alert.
    expect(emittedSignals[0]!.dedupeKey).not.toBe(emittedSignals[1]!.dedupeKey);
  });

  test("an unknown result neither alerts nor clears an existing alert", async () => {
    setFailing();
    await runTelegramWebhookHealthCheck();
    expect(emittedSignals).toHaveLength(1);

    // Our own network dropping is not evidence the webhook recovered.
    fetchOutcome = { kind: "throw", message: "network unreachable" };
    await runTelegramWebhookHealthCheck();
    expect(emittedSignals).toHaveLength(1);

    setFailing();
    await runTelegramWebhookHealthCheck();

    // Still the same outage — the latch survived the unknown round.
    expect(emittedSignals).toHaveLength(1);
  });

  test("a failed emit is retried on the next round", async () => {
    // Exercises the real contract: the mock only throws because the caller
    // passes throwOnError. Drop that param and this test fails, which is the
    // point — the retry path must not be able to go dead silently.
    setFailing();
    emitFails = true;
    await runTelegramWebhookHealthCheck();
    expect(emittedSignals).toHaveLength(0);

    emitFails = false;
    await runTelegramWebhookHealthCheck();

    expect(emittedSignals).toHaveLength(1);
  });
});

// Restore after the suite, not at module scope — a top-level restore would run
// while the describes are still registering, i.e. before any test executes.
afterAll(() => {
  globalThis.fetch = originalFetch;
});
