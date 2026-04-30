#!/usr/bin/env bun
/**
 * Checks whether Stripe credentials are already configured.
 *
 * Outputs JSON: { configured: boolean, details?: string }
 *
 * Species-gated: delegates to a species-specific implementation.
 */

const species = process.env.SPECIES;

async function checkVellum(): Promise<void> {
  const proc = Bun.spawn(["assistant", "credentials", "list", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.log(
      JSON.stringify({
        configured: false,
        details: "Failed to list credentials",
      }),
    );
    return;
  }

  try {
    const credentials = JSON.parse(stdout) as Array<{
      service?: string;
      field?: string;
    }>;
    const hasApiKey = credentials.some(
      (c) => c.service === "stripe" && c.field === "api_key",
    );
    console.log(
      JSON.stringify({
        configured: hasApiKey,
        details: hasApiKey
          ? "Stripe api_key found in credential store"
          : "No stripe api_key found",
      }),
    );
  } catch {
    console.log(
      JSON.stringify({
        configured: false,
        details: "Failed to parse credentials list",
      }),
    );
  }
}

async function main(): Promise<void> {
  switch (species) {
    case "vellum":
      await checkVellum();
      break;
    default:
      console.error(
        `Unsupported species: ${species ?? "(not set)"}. This skill currently only supports species=vellum.`,
      );
      process.exitCode = 1;
  }
}

main();
