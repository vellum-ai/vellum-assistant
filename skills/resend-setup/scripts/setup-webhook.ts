#!/usr/bin/env bun
/**
 * Registers a Resend webhook and stores the signing secret automatically.
 *
 * Usage: bun skills/resend-setup/scripts/setup-webhook.ts [--domain <domain>]
 *
 * 1. Gets a callback URL via `assistant webhooks register resend`
 * 2. Creates the webhook via the Resend API (using proxied credentials)
 * 3. Stores the returned signing_secret in the credential vault
 *
 * Species-gated: delegates to a species-specific implementation.
 */

import { parseArgs } from "node:util";

const species = process.env.SPECIES;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    domain: { type: "string" },
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
  const domain = values.domain;

  // Step 1: Get the callback URL
  const registerArgs = ["assistant", "webhooks", "register", "resend"];
  if (domain) registerArgs.push("--source", domain);
  registerArgs.push("--json");

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

  // Step 2: Create the webhook via Resend API
  const payload = JSON.stringify({
    endpoint: callbackUrl,
    events: ["email.received"],
  });

  const curlArgs = [
    "curl",
    "-s",
    "-X",
    "POST",
    "https://api.resend.com/webhooks",
    "-H",
    "Content-Type: application/json",
    "-d",
    payload,
  ];

  // Use proxied network mode to inject the Resend API key
  const curlResult = await run(curlArgs);
  if (curlResult.exitCode !== 0) {
    console.error("Failed to create webhook via Resend API.");
    process.exitCode = 1;
    return;
  }

  let webhookResponse: {
    object?: string;
    id?: string;
    signing_secret?: string;
  };
  try {
    webhookResponse = JSON.parse(curlResult.stdout);
  } catch {
    console.error(`Unexpected Resend API response: ${curlResult.stdout}`);
    process.exitCode = 1;
    return;
  }

  if (!webhookResponse.signing_secret) {
    console.error(
      `Resend API did not return a signing secret: ${curlResult.stdout}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Webhook created: ${webhookResponse.id}`);

  // Step 3: Store the signing secret
  const storeResult = await run([
    "assistant",
    "credentials",
    "set",
    "--service",
    "resend",
    "--field",
    "webhook_secret",
    "--label",
    "Resend Webhook Signing Secret",
    "--description",
    "Auto-configured signing secret for verifying inbound Resend webhooks",
    webhookResponse.signing_secret,
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
