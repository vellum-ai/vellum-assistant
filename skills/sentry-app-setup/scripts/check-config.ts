#!/usr/bin/env bun
/**
 * Checks whether Sentry credentials are already configured.
 *
 * Outputs JSON: { configured: boolean, details?: string }
 *
 * Species-gated: delegates to a species-specific implementation.
 */

const species = process.env.SPECIES;

// ---------------------------------------------------------------------------
// Vellum — checks the encrypted credential vault via `assistant credentials`
// ---------------------------------------------------------------------------

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
  } catch {
    console.log(
      JSON.stringify({
        configured: false,
        details: "Failed to parse credentials list",
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// OpenClaw — checks ~/.openclaw/credentials.json
// ---------------------------------------------------------------------------

async function checkOpenClaw(): Promise<void> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const credPath = `${home}/.openclaw/credentials.json`;

  const file = Bun.file(credPath);
  if (!(await file.exists())) {
    console.log(
      JSON.stringify({
        configured: false,
        details: `No credentials file at ${credPath}`,
      }),
    );
    return;
  }

  try {
    const creds = (await file.json()) as Record<string, unknown>;
    const hasToken = typeof creds["sentry_auth_token"] === "string";
    console.log(
      JSON.stringify({
        configured: hasToken,
        details: hasToken
          ? "sentry_auth_token found in ~/.openclaw/credentials.json"
          : "No sentry_auth_token in credentials file",
      }),
    );
  } catch {
    console.log(
      JSON.stringify({
        configured: false,
        details: "Failed to parse credentials file",
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Hermes — checks the Hermes keyring via `hermes secret get`
// ---------------------------------------------------------------------------

async function checkHermes(): Promise<void> {
  const proc = Bun.spawn(
    ["hermes", "secret", "get", "sentry/auth_token", "--quiet"],
    { stdout: "pipe", stderr: "pipe" },
  );

  const exitCode = await proc.exited;
  console.log(
    JSON.stringify({
      configured: exitCode === 0,
      details:
        exitCode === 0
          ? "sentry/auth_token found in Hermes keyring"
          : "No sentry/auth_token in Hermes keyring",
    }),
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  switch (species) {
    case "vellum":
      await checkVellum();
      break;
    case "openclaw":
      await checkOpenClaw();
      break;
    case "hermes":
      await checkHermes();
      break;
    default:
      console.error(
        `Unsupported species: ${species ?? "(not set)"}. Supported: vellum, openclaw, hermes.`,
      );
      process.exitCode = 1;
  }
}

main();
