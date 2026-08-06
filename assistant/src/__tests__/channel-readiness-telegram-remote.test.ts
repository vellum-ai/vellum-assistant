/**
 * The Telegram probe's remote check.
 *
 * Local checks establish that credentials exist. That is a different claim
 * from "messages arrive": a registration that never landed leaves every
 * credential in place and the channel dark, which is how the readiness
 * indicator went green on a channel nobody could reach.
 *
 * The classification lives in `checkTelegramWebhookHealth`, which already
 * handles error recency and the managed-versus-self-hosted recovery text.
 * These tests pin how the probe maps its verdicts, in particular that the two
 * no-evidence statuses pass: a probe that cannot see the answer must not
 * report a fault.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { TelegramWebhookHealthResult } from "../telegram/webhook-health.js";

let health: TelegramWebhookHealthResult;

mock.module("../telegram/webhook-health.js", () => ({
  checkTelegramWebhookHealth: async () => health,
}));

mock.module("../calls/twilio-rest.js", () => ({
  hasTwilioCredentials: () => false,
}));
mock.module("../calls/twilio-config.js", () => ({
  resolveTwilioPhoneNumber: () => undefined,
}));
mock.module("../runtime/channel-invite-transports/whatsapp.js", () => ({
  resolveWhatsAppDisplayNumber: () => undefined,
}));

async function runTelegramRemoteProbe() {
  const { createReadinessService } =
    await import("../runtime/channel-readiness-service.js");
  const service = createReadinessService();
  return service.getReadiness("telegram", true);
}

async function deliveryCheck() {
  const [snapshot] = await runTelegramRemoteProbe();
  const remote = snapshot.remoteChecks ?? [];
  const result = remote.find((c) => c.name === "webhook_delivery");
  if (!result) {
    throw new Error(
      `no webhook_delivery check ran; got: ${remote.map((c) => c.name).join(", ") || "(none)"}`,
    );
  }
  return result;
}

beforeEach(() => {
  health = { status: "healthy", detail: "ok" };
});

afterEach(() => {
  mock.restore();
});

describe("telegram remote probe (webhook delivery)", () => {
  test("passes when Telegram reports a healthy webhook", async () => {
    health = { status: "healthy", detail: "delivering" };

    expect((await deliveryCheck()).passed).toBe(true);
  });

  test("fails when no webhook is registered, carrying the recovery text", async () => {
    health = {
      status: "not_registered",
      detail: "Telegram has no webhook registered. Contact support.",
    };

    const result = await deliveryCheck();
    expect(result.passed).toBe(false);
    // The detail carries fixPath()'s managed-versus-self-hosted guidance, so
    // the probe relays it rather than substituting wording of its own.
    expect(result.message).toBe(health.detail);
  });

  test("fails when Telegram reports a recent delivery error", async () => {
    health = {
      status: "delivery_failing",
      detail: 'Telegram reported "Connection refused"',
    };

    const result = await deliveryCheck();
    expect(result.passed).toBe(false);
    expect(result.message).toBe(health.detail);
  });

  test("passes when the check was skipped for want of preconditions", async () => {
    // Nothing was checked, so there is no fault to report. Failing here would
    // flag every install that has not configured Telegram at all.
    health = { status: "skipped", detail: "no bot token stored" };

    expect((await deliveryCheck()).passed).toBe(true);
  });

  test("passes when Telegram could not be reached", async () => {
    // An unreachable API says nothing about whether the webhook is good.
    // Failing here would turn a network blip into a broken-channel report.
    health = { status: "unknown", detail: "could not reach Telegram" };

    expect((await deliveryCheck()).passed).toBe(true);
  });
});
