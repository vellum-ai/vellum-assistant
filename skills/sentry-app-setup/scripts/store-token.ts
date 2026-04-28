#!/usr/bin/env bun
/**
 * Prompts the user for a Sentry auth token and stores it in the credential vault.
 *
 * Species-gated: delegates to a species-specific implementation.
 */

// ---------------------------------------------------------------------------
// Vellum — secure UI prompt via `assistant credentials prompt`
// ---------------------------------------------------------------------------

async function storeTokenVellum(): Promise<void> {
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
  if (exitCode !== 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// OpenClaw — writes to ~/.openclaw/credentials.json
// ---------------------------------------------------------------------------

async function storeTokenOpenClaw(): Promise<void> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const credDir = `${home}/.openclaw`;
  const credPath = `${credDir}/credentials.json`;

  // Read the token from stdin (OpenClaw pipes secrets through stdin)
  const proc = Bun.spawn(
    ["openclaw", "secret", "collect", "--label", "Sentry Auth Token"],
    { stdout: "pipe", stderr: "inherit" },
  );
  const token = (await new Response(proc.stdout).text()).trim();
  const exitCode = await proc.exited;
  if (exitCode !== 0 || !token) {
    console.error("Failed to collect token");
    process.exitCode = 1;
    return;
  }

  // Ensure directory exists
  await Bun.spawn(["mkdir", "-p", credDir]).exited;

  // Read existing credentials or start fresh
  const file = Bun.file(credPath);
  let creds: Record<string, unknown> = {};
  if (await file.exists()) {
    try {
      creds = (await file.json()) as Record<string, unknown>;
    } catch {
      // Corrupted file — start fresh
    }
  }

  creds["sentry_auth_token"] = token;
  await Bun.write(credPath, JSON.stringify(creds, null, 2) + "\n");

  // Restrict file permissions
  await Bun.spawn(["chmod", "600", credPath]).exited;

  console.log("✓ Sentry auth token stored in ~/.openclaw/credentials.json");
}

// ---------------------------------------------------------------------------
// Hermes — stores in the Hermes keyring via `hermes secret set`
// ---------------------------------------------------------------------------

async function storeTokenHermes(): Promise<void> {
  const proc = Bun.spawn(
    [
      "hermes",
      "secret",
      "set",
      "sentry/auth_token",
      "--label",
      "Sentry Auth Token",
      "--prompt",
      "--allowed-hosts",
      "sentry.io",
      "--inject-as",
      "header:Authorization:Bearer",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  switch (process.env.SPECIES) {
    case "vellum":
      await storeTokenVellum();
      break;
    case "openclaw":
      await storeTokenOpenClaw();
      break;
    case "hermes":
      await storeTokenHermes();
      break;
    default:
      console.error(
        `Unsupported species: ${process.env.SPECIES ?? "(not set)"}. Supported: vellum, openclaw, hermes.`,
      );
      process.exitCode = 1;
  }
}

main();
