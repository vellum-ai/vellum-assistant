#!/usr/bin/env bun
/**
 * Prompts the user for a Mailgun webhook signing key and stores it in the credential vault.
 *
 * The signing key is found in the Mailgun dashboard under Settings > API Security >
 * "HTTP Webhook Signing Key". Unlike Resend, Mailgun does not return the signing key
 * from any API endpoint — it must be copied from the dashboard.
 *
 * Species-gated: delegates to a species-specific implementation.
 */

const species = process.env.SPECIES;

async function storeVellum(): Promise<void> {
  const args = [
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
  ];

  const proc = Bun.spawn(["assistant", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  switch (species) {
    case "vellum":
      await storeVellum();
      break;
    default:
      console.error(
        `Unsupported species: ${species ?? "(not set)"}. This skill currently only supports species=vellum.`,
      );
      process.exitCode = 1;
  }
}

main();
