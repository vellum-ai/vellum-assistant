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
 * These tests pin how the probe maps its verdicts across three outcomes, not
 * two: verified pass, hard failure, and the no-evidence statuses that are
 * neither. A probe that cannot see the answer must not report a fault, and
 * must not be counted as proof either.
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

  test("fails when Telegram holds a webhook this deployment did not register", async () => {
    // The case last_error_date cannot see: on a quiet channel a stale tunnel
    // address or another deployment's callback never produces a delivery
    // error, so before the URL comparison this read as healthy.
    health = {
      status: "url_mismatch",
      detail: "Telegram is registered at a different address",
      registeredUrl: "https://stale.example/webhooks/telegram",
      expectedUrl: "https://current.example/webhooks/telegram",
    };

    const result = await deliveryCheck();
    expect(result.passed).toBe(false);
    expect(result.message).toBe(health.detail);
  });

  // The three indeterminate statuses. Each must satisfy BOTH halves: no fault
  // reported (so a network blip does not paint a working channel broken), and
  // not counted as evidence (so nothing can claim delivery from a check that
  // never established it). Asserting only `passed` would let a regression that
  // drops `indeterminate` through, which is exactly the false-success this
  // contract exists to prevent.
  const indeterminateCases = [
    ["skipped", "no bot token stored"],
    ["unknown", "could not reach Telegram"],
    ["unverified", "no record of registering this webhook"],
  ] as const;

  for (const [status, detail] of indeterminateCases) {
    test(`${status} is indeterminate: no fault reported, but not proof of delivery`, async () => {
      health = { status, detail };

      const result = await deliveryCheck();
      expect(result.passed).toBe(true);
      expect(result.indeterminate).toBe(true);
    });
  }

  test("an untouched install stays not_configured rather than incomplete", async () => {
    // setupStatus separates not_configured from incomplete by asking whether
    // any check passed. Counting an indeterminate check there reported a
    // workspace with no Telegram credentials at all as half-finished, which is
    // what routes the Channels UI to the "finish setup" prompt instead of the
    // normal setup flow.
    health = { status: "skipped", detail: "no bot token stored" };

    const [snapshot] = await runTelegramRemoteProbe();
    expect(snapshot.setupStatus).toBe("not_configured");
    expect(snapshot.ready).toBe(false);
  });

  test("a verified healthy result is not marked indeterminate", async () => {
    // Sensitivity check for the cases above: if `indeterminate` were set
    // unconditionally they would pass while proving nothing.
    health = { status: "healthy", detail: "registered where we set it" };

    const result = await deliveryCheck();
    expect(result.passed).toBe(true);
    expect(result.indeterminate).toBeFalsy();
  });
});
