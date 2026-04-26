#!/usr/bin/env bun
/**
 * Stores the Sentry auth token via the species-specific credential mechanism.
 *
 * For Vellum: uses `assistant credentials prompt` to securely collect the token.
 *
 * Outputs JSON: { stored: boolean, details?: string }
 *
 * Species-gated: delegates to a species-specific implementation.
 */

const species = process.env.SPECIES;

async function storeVellum(): Promise<void> {
  // This script outputs the credential_store call parameters as JSON.
  // The LLM reads this output and makes the actual credential_store tool call.
  console.log(
    JSON.stringify({
      action: "prompt",
      service: "sentry",
      field: "auth_token",
      label: "Sentry Auth Token",
      placeholder: "sntrys_...",
      description:
        "Auth token from your Sentry internal integration (found on the integration's details page under Tokens)",
      allowed_domains: ["sentry.io"],
      injection_templates: [
        {
          hostPattern: "sentry.io",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Bearer ",
        },
      ],
    }),
  );
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
