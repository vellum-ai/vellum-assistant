import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mutable mock state ────────────────────────────────────────────────

const secureKeyValues = new Map<string, string>();

let webhookRouting: { configured: boolean; usesManagedCallbacks: boolean } = {
  configured: true,
  usesManagedCallbacks: false,
};

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
let emitThrows = false;

// ── Module mocks ──────────────────────────────────────────────────────

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => secureKeyValues.get(account),
}));

mock.module("../../security/credential-key.js", () => ({
  credentialKey: (service: string, field: string) =>
    `credential/${service}/${field}`,
}));

mock.module("../../config/webhook-routing.js", () => ({
  hasWebhookRoutingConfigured: () => webhookRouting,
  hasIngressConfigured: () => webhookRouting.configured,
}));

mock.module("../bot-username.js", () => ({
  getTelegramBotUsername: () => "test_bot",
  getTelegramBotId: () => "123",
}));

let apiBaseUrl = "https://api.telegram.org";

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ telegram: { apiBaseUrl } }),
}));

mock.module("../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    if (emitThrows) {
      throw new Error("emit failed");
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
  webhookRouting = { configured: true, usesManagedCallbacks: false };
  setWebhookInfo({ url: WEBHOOK_URL, pending_update_count: 0 });
  fetchCallCount = 0;
  fetchedUrls.length = 0;
  apiBaseUrl = "https://api.telegram.org";
  emittedSignals.length = 0;
  emitThrows = false;
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

  test("does not run when no webhook routing is configured", async () => {
    webhookRouting = { configured: false, usesManagedCallbacks: false };

    const result = await runTelegramWebhookHealthCheck();

    expect(result.status).toBe("skipped");
    expect(fetchCallCount).toBe(0);
    expect(emittedSignals).toHaveLength(0);
  });

  test("runs when platform-managed callbacks stand in for public ingress", async () => {
    webhookRouting = { configured: true, usesManagedCallbacks: true };
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
    expect(signal.sourceChannel).toBe("watcher");
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
    setFailing();
    emitThrows = true;
    await runTelegramWebhookHealthCheck();
    expect(emittedSignals).toHaveLength(0);

    emitThrows = false;
    await runTelegramWebhookHealthCheck();

    expect(emittedSignals).toHaveLength(1);
  });
});

// Restore after the suite, not at module scope — a top-level restore would run
// while the describes are still registering, i.e. before any test executes.
afterAll(() => {
  globalThis.fetch = originalFetch;
});
