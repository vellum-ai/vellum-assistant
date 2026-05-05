#!/usr/bin/env bun
/**
 * Checks whether Sentry credentials are already configured.
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
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.log(
      JSON.stringify({
        configured: false,
        details: `Failed to list credentials (exit ${exitCode}): ${stderr.trim()}`,
      }),
    );
    return;
  }

  try {
    const credentials = JSON.parse(stdout) as Array<{
      service?: string;
      field?: string;
    }>;
    const hasToken = credentials.some(
      (c) => c.service === "sentry" && c.field === "auth_token",
    );
    console.log(
      JSON.stringify({
        configured: hasToken,
        details: hasToken
          ? "Sentry auth_token found in credential store"
          : "No sentry auth_token found",
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify({
        configured: false,
        details: `Failed to parse credentials list: ${message}. Raw output: ${stdout.slice(0, 200)}`,
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
