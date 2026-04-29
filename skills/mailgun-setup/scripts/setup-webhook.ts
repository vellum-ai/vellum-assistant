#!/usr/bin/env bun
/**
 * Sets up Mailgun inbound email:
 *   1. Registers a callback URL via the webhooks system
 *   2. Creates an inbound route in Mailgun
 *   3. Prompts the user for their webhook signing key
 *
 * Usage: bun skills/mailgun-setup/scripts/setup-webhook.ts --domain <domain> [--region eu]
 *
 * Species-gated: delegates to a species-specific implementation.
 */

import { parseArgs } from "node:util";

const species = process.env.SPECIES;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    domain: { type: "string" },
    region: { type: "string", default: "us" },
  },
  strict: false,
});

async function run(
  cmd: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "inherit",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

async function setupVellum(): Promise<void> {
  const domain = values.domain;
  if (!domain) {
    console.error("--domain is required");
    process.exitCode = 1;
    return;
  }

  const isEu = values.region?.toLowerCase() === "eu";
  const apiBase = isEu
    ? "https://api.eu.mailgun.net"
    : "https://api.mailgun.net";

  // Step 1: Get the callback URL
  const registerArgs = [
    "assistant",
    "webhooks",
    "register",
    "mailgun",
    "--source",
    domain,
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

  // Step 2: Retrieve the API key from the vault
  const keyResult = await run([
    "assistant",
    "credentials",
    "reveal",
    "--service",
    "mailgun",
    "--field",
    "api_key",
  ]);
  if (keyResult.exitCode !== 0 || !keyResult.stdout) {
    console.error("Failed to retrieve Mailgun API key from credential vault.");
    process.exitCode = 1;
    return;
  }
  const apiKey = keyResult.stdout;

  // Step 3: Create the inbound route
  const curlArgs = [
    "curl",
    "-s",
    "--user",
    `api:${apiKey}`,
    `${apiBase}/v3/routes`,
    "-F",
    "priority=0",
    "-F",
    "description=Forward inbound email to assistant",
    "-F",
    `expression=match_recipient('.*@${domain}')`,
    "-F",
    `action=forward('${callbackUrl}')`,
    "-F",
    "action=stop()",
  ];

  const routeResult = await run(curlArgs);
  if (routeResult.exitCode !== 0) {
    console.error("Failed to create inbound route via Mailgun API.");
    process.exitCode = 1;
    return;
  }

  let routeResponse: { route?: { id?: string }; message?: string };
  try {
    routeResponse = JSON.parse(routeResult.stdout);
  } catch {
    console.error(`Unexpected Mailgun API response: ${routeResult.stdout}`);
    process.exitCode = 1;
    return;
  }

  if (routeResponse.route?.id) {
    console.log(`Inbound route created: ${routeResponse.route.id}`);
  } else {
    console.log(`Mailgun response: ${routeResult.stdout}`);
  }

  // Step 4: Prompt for the webhook signing key
  const storeProc = Bun.spawn(
    [
      "assistant",
      "credentials",
      "prompt",
      "--service",
      "mailgun",
      "--field",
      "webhook_signing_key",
      "--label",
      "Mailgun Webhook Signing Key",
      "--placeholder",
      "key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "--description",
      "Webhook signing key from Mailgun dashboard (Settings > API Security > HTTP Webhook Signing Key)",
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  const storeExit = await storeProc.exited;
  if (storeExit !== 0) {
    console.error("Failed to store webhook signing key.");
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify({
      ok: true,
      callbackUrl,
      routeId: routeResponse.route?.id,
      signingKeyStored: true,
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
