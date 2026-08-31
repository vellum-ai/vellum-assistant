#!/usr/bin/env bun
/**
 * Checks whether Discord credentials are already configured.
 *
 * Outputs JSON: { configured: boolean, details?: string, error?: string }
 *
 * `configured: false` means the check ran and found no token. When the check
 * could not run at all, `error` is set and the caller must say so instead of
 * reporting "not configured": those are different states with different
 * remedies, and conflating them sends the user off to re-run a setup that was
 * never the problem.
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

/** Report that the check could not run, which is not the same as "no token". */
function reportError(error: string, details: string): void {
  console.log(JSON.stringify({ configured: false, error, details }));
  process.exitCode = 1;
}

async function checkVellum(): Promise<void> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["assistant", "credentials", "list", "--json"], {
      windowsHide: true,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    // The CLI is not on PATH. Nothing has been checked, so the credential
    // state is unknown rather than absent.
    reportError(
      "cli_not_found",
      `Could not run the 'assistant' command: ${err instanceof Error ? err.message : String(err)}. The credential state is unknown. This is an installation problem, not a Discord setup problem.`,
    );
    return;
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // 127 is the shell's "command not found". Anything non-zero means the
    // lookup did not happen, so do not answer as though it did.
    reportError(
      exitCode === 127 ? "cli_not_found" : "cli_failed",
      `'assistant credentials list' exited ${exitCode}. The credential state is unknown.${stderr.trim() ? ` stderr: ${stderr.trim()}` : ""}`,
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    reportError(
      "unparseable_output",
      stdout.trim().length === 0
        ? "'assistant credentials list' produced no output. The credential state is unknown."
        : "Could not parse the credentials list. The credential state is unknown.",
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
