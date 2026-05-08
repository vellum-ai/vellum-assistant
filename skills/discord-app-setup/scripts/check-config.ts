#!/usr/bin/env bun
/**
 * Checks whether Discord credentials are already configured.
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
    const credentials = JSON.parse(stdout.trim()) as Array<{
      service?: string;
      field?: string;
    }>;
    const hasToken = credentials.some(
      (c) => c.service === "discord_channel" && c.field === "bot_token",
    );

    let appId = "";
    if (hasToken) {
      const cfgProc = Bun.spawn(
        ["assistant", "config", "get", "discord_channel.applicationId"],
        { stdout: "pipe", stderr: "pipe" },
      );
      appId = (await new Response(cfgProc.stdout).text()).trim();
      await cfgProc.exited;
    }

    console.log(
      JSON.stringify({
        configured: hasToken,
        details: hasToken
          ? `Discord bot_token found${appId ? ` (application ${appId})` : " (application metadata not yet captured — run validate-and-configure.ts)"}`
          : "No discord_channel bot_token found",
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
