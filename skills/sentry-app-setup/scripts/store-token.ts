#!/usr/bin/env bun
/**
 * Prompts the user for a Sentry auth token and stores it in the credential vault.
 *
 * Species-gated: delegates to a species-specific implementation.
 */

const species = process.env.SPECIES;

async function storeVellum(): Promise<void> {
  const args = [
    "credentials",
    "prompt",
    "--service",
    "sentry",
    "--field",
    "auth_token",
    "--label",
    "Sentry Auth Token",
    "--placeholder",
    "sntrys_...",
    "--description",
    "Auth token from your Sentry internal integration (found on the integration's details page under Tokens)",
    "--allowed-domains",
    "sentry.io",
    "--allowed-tools",
    "bash",
    "--injection-templates",
    JSON.stringify([
      {
        hostPattern: "sentry.io",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ]),
  ];

  const proc = Bun.spawn(["assistant", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  // Exit 130 is the CLI's "user cancelled the secure prompt" signal (SIGINT
  // convention) — a valid choice, not a failure, and nothing was stored.
  // Propagate it verbatim so the caller can distinguish it from a real error
  // (any other non-zero exit).
  if (exitCode !== 0) {
    process.exitCode = exitCode === 130 ? 130 : 1;
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
