#!/usr/bin/env bun
/**
 * Registers a Stripe webhook endpoint and stores the signing secret automatically.
 *
 * Usage: bun skills/stripe-app-setup/scripts/setup-webhook.ts [--events <comma-separated>]
 *
 * 1. Gets a callback URL via `assistant webhooks register stripe`
 * 2. Creates the webhook endpoint via the Stripe API (using proxied credentials)
 * 3. Stores the returned signing secret in the credential vault
 *
 * Default events: payment_intent.succeeded, payment_intent.payment_failed,
 *   customer.subscription.created, customer.subscription.updated,
 *   customer.subscription.deleted, invoice.payment_succeeded,
 *   invoice.payment_failed, charge.succeeded, charge.failed,
 *   charge.dispute.created
 *
 * Species-gated: delegates to a species-specific implementation.
 */

import { parseArgs } from "node:util";

const species = process.env.SPECIES;

const DEFAULT_EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "charge.succeeded",
  "charge.failed",
  "charge.dispute.created",
];

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    events: { type: "string" },
  },
  strict: false,
});

async function run(
  cmd: string[],
  opts?: { env?: Record<string, string> },
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ...opts?.env },
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

async function setupVellum(): Promise<void> {
  const events = values.events
    ? values.events.split(",").map((e) => e.trim())
    : DEFAULT_EVENTS;

  // Step 1: Get the callback URL
  const registerArgs = [
    "assistant",
    "webhooks",
    "register",
    "stripe",
    "--source",
    "stripe",
    "--json",
  ];

  const reg = await run(registerArgs);
  if (reg.exitCode !== 0) {
    console.error(
      "Failed to register webhook URL. Is the assistant webhooks system configured?",
    );
    process.exitCode = 1;
    return;
  }

  let callbackUrl: string;
  try {
    const data = JSON.parse(reg.stdout);
    callbackUrl = data.url || data.callback_url;
  } catch {
    // If not JSON, treat stdout as the URL itself
    callbackUrl = reg.stdout;
  }

  if (!callbackUrl) {
    console.error(
      "Could not determine callback URL from webhook registration.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Callback URL: ${callbackUrl}`);

  // Step 2: Create the webhook endpoint via Stripe API
  // Stripe uses form-encoded POST, not JSON
  const formParts = [`url=${encodeURIComponent(callbackUrl)}`];
  for (const event of events) {
    formParts.push(`enabled_events[]=${encodeURIComponent(event)}`);
  }

  const curlArgs = [
    "curl",
    "-s",
    "-X",
    "POST",
    "https://api.stripe.com/v1/webhook_endpoints",
    "-d",
    formParts.join("&"),
  ];

  // Uses proxied network mode to inject the Stripe API key
  const curlResult = await run(curlArgs);
  if (curlResult.exitCode !== 0) {
    console.error("Failed to create webhook endpoint via Stripe API.");
    process.exitCode = 1;
    return;
  }

  let webhookResponse: {
    id?: string;
    secret?: string;
    error?: { message?: string };
  };
  try {
    webhookResponse = JSON.parse(curlResult.stdout);
  } catch {
    console.error(`Unexpected Stripe API response: ${curlResult.stdout}`);
    process.exitCode = 1;
    return;
  }

  if (webhookResponse.error) {
    console.error(
      `Stripe API error: ${webhookResponse.error.message ?? curlResult.stdout}`,
    );
    process.exitCode = 1;
    return;
  }

  if (!webhookResponse.secret) {
    console.error(
      `Stripe API did not return a signing secret: ${curlResult.stdout}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Webhook endpoint created: ${webhookResponse.id}`);

  // Step 3: Store the signing secret
  const storeResult = await run([
    "assistant",
    "credentials",
    "set",
    "--service",
    "stripe",
    "--field",
    "webhook_secret",
    "--label",
    "Stripe Webhook Signing Secret",
    "--description",
    "Auto-configured signing secret for verifying inbound Stripe webhooks",
    "--",
    webhookResponse.secret,
  ]);

  if (storeResult.exitCode !== 0) {
    console.error("Failed to store webhook signing secret.");
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify({
      ok: true,
      webhookId: webhookResponse.id,
      callbackUrl,
      secretStored: true,
      events,
    }),
  );
}

async function main(): Promise<void> {
  switch (species) {
    case "vellum":
      await setupVellum();
      break;
    default:
      console.error(
        `Unsupported species: ${species ?? "(not set)"}. This skill currently only supports species=vellum.`,
      );
      process.exitCode = 1;
  }
}

main();
