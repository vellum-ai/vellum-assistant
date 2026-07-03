#!/usr/bin/env bun
/**
 * Prompts the user for a Resend API key and stores it in the credential vault.
 *
 * Species-gated: delegates to a species-specific implementation.
 */

const species = process.env.SPECIES;

async function storeVellum(): Promise<void> {
  const args = [
    "credentials",
    "prompt",
    "--service",
    "resend",
    "--field",
    "api_key",
    "--label",
    "Resend API Key",
    "--placeholder",
    "re_xxxxxxxxx",
    "--description",
    "Your Resend API key for sending emails",
    "--allowed-domains",
    "api.resend.com",
    "--allowed-tools",
    "bash",
    "--injection-templates",
    JSON.stringify([
      {
        hostPattern: "*.resend.com",
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

  // Propagate the CLI's exit code verbatim: 0 = stored, 130 = user cancelled
  // the secure prompt (a valid choice — nothing stored), any other non-zero =
  // a real error.
  process.exitCode = await proc.exited;
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
