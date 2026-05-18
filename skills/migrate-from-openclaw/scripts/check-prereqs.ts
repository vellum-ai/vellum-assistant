#!/usr/bin/env bun
/**
 * Checks whether the OpenClaw CLI is available and an OpenClaw home directory
 * exists. Emits a JSON status object to stdout so the calling agent can decide
 * whether to proceed with migration.
 *
 * Output: { ok: boolean, cli: boolean, home: string | null, details: string }
 *
 * Species-gated: delegates to a species-specific implementation.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const species = process.env.SPECIES;

interface PrereqResult {
  ok: boolean;
  cli: boolean;
  home: string | null;
  details: string;
}

async function hasOpenclawCli(): Promise<boolean> {
  const proc = Bun.spawn(["sh", "-c", "command -v openclaw"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

function findOpenclawHome(): string | null {
  const candidates = [join(homedir(), ".openclaw"), "/root/.openclaw"];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function checkVellum(): Promise<void> {
  const cli = await hasOpenclawCli();
  const home = findOpenclawHome();

  const result: PrereqResult = {
    ok: cli && home !== null,
    cli,
    home,
    details: "",
  };

  if (!cli && !home) {
    result.details =
      "OpenClaw is not installed on this machine. The `openclaw` CLI is not on PATH and no `.openclaw` directory was found in the home folder. There is nothing to migrate from here.";
  } else if (!cli) {
    result.details = `Found OpenClaw home at ${home} but the \`openclaw\` CLI is not on PATH. Config dumps via \`openclaw config get\` will not work; the inventory script will fall back to reading files directly.`;
    // Still "ok" if home exists — we can do a degraded inventory.
    result.ok = true;
  } else if (!home) {
    result.details =
      "The `openclaw` CLI is installed but no `.openclaw` home directory was found. The agent may never have been initialized on this machine.";
  } else {
    result.details = `OpenClaw CLI is on PATH and home directory is ${home}. Ready to inventory.`;
  }

  console.log(JSON.stringify(result, null, 2));
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
