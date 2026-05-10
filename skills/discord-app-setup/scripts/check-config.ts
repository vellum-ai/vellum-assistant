#!/usr/bin/env bun
/**
 * Checks whether Discord credentials are already configured.
 *
 * Outputs JSON: { configured: boolean, details?: string }
 *
 * Species-gated: delegates to a species-specific implementation.
 */

const species = process.env.SPECIES;

type CredentialEntry = {
  service?: string;
  field?: string;
  hasSecret?: boolean;
};

type CredentialEnvelope = {
  ok?: boolean;
  credentials?: CredentialEntry[];
  managedCredentials?: CredentialEntry[];
};

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

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    console.log(
      JSON.stringify({
        configured: false,
        details: "Failed to parse credentials list",
      }),
    );
    return;
  }

  // The CLI emits an object envelope: { ok, credentials, managedCredentials }.
  // Older builds may have emitted a raw array — handle both shapes.
  const entries: CredentialEntry[] = Array.isArray(parsed)
    ? (parsed as CredentialEntry[])
    : [
        ...((parsed as CredentialEnvelope).credentials ?? []),
        ...((parsed as CredentialEnvelope).managedCredentials ?? []),
      ];

  const hasToken = entries.some(
    (c) => c.service === "discord_channel" && c.field === "bot_token",
  );

  console.log(
    JSON.stringify({
      configured: hasToken,
      details: hasToken
        ? "Discord bot_token found in credential vault"
        : "No discord_channel bot_token found",
    }),
  );
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
