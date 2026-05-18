#!/usr/bin/env bun
/**
 * Inventories an OpenClaw install and emits a structured migration plan.
 *
 * For each key in `references/mapping.md`, tries `openclaw config get <key>`
 * (if the CLI is available) and records the value. Also lists files under the
 * OpenClaw home directory and flags ones that look like credentials.
 *
 * Output: writes the plan to /tmp/openclaw-migration-plan.json AND prints it
 * to stdout for the calling agent to read.
 *
 * Species-gated: delegates to a species-specific implementation.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const species = process.env.SPECIES;

interface MappedKey {
  source: string;
  destination: string | null; // null means "no known mapping"
  notes: string;
}

interface ConfigEntry {
  source_key: string;
  value: string | null;
  mapping: "known" | "unknown";
  destination?: string;
  notes?: string;
}

interface SecretEntry {
  path: string;
  hint: string;
}

interface GatewayState {
  registered: boolean;
  service: string | null;
  details: string;
}

interface Plan {
  config: ConfigEntry[];
  secret_paths: SecretEntry[];
  gateway: GatewayState;
  home: string | null;
  cli_available: boolean;
  warnings: string[];
}

// --- Helpers ---

function getMappingPath(): string {
  // scripts/ lives at <skill>/scripts/inventory.ts; mapping at <skill>/references/mapping.md
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "references", "mapping.md");
}

/**
 * Parse references/mapping.md and return the known key mappings.
 * Format: a Markdown table with columns | source | destination | notes |.
 */
function parseMapping(): MappedKey[] {
  const path = getMappingPath();
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf-8").split("\n");
  const rows: MappedKey[] = [];

  for (const line of lines) {
    // Skip non-table lines, headers, and separator rows.
    if (!line.startsWith("|")) continue;
    if (line.includes("---")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    // Skip the header row by checking for backticked content in the source cell.
    if (
      cells[0] === "source" ||
      cells[0] === "Source" ||
      cells[0] === "OpenClaw key"
    ) {
      continue;
    }

    const source = cells[0].replace(/^`|`$/g, "");
    const destinationRaw = cells[1].replace(/^`|`$/g, "").trim();
    const destination =
      destinationRaw === "" || destinationRaw === "—" ? null : destinationRaw;
    const notes = cells[2] ?? "";

    if (source) {
      rows.push({ source, destination, notes });
    }
  }

  return rows;
}

async function openclawCliAvailable(): Promise<boolean> {
  const proc = Bun.spawn(["sh", "-c", "command -v openclaw"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

async function getOpenclawConfig(key: string): Promise<string | null> {
  const proc = Bun.spawn(["openclaw", "config", "get", key], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const trimmed = stdout.trim();
  return trimmed === "" ? null : trimmed;
}

function findOpenclawHome(): string | null {
  const candidates = [join(homedir(), ".openclaw"), "/root/.openclaw"];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

const SECRET_HINTS = [
  { match: /gateway[-_.]?token/i, hint: "gateway auth token" },
  { match: /api[-_.]?key/i, hint: "API key" },
  { match: /access[-_.]?token/i, hint: "OAuth access token" },
  { match: /\.pem$|\.key$|private[-_.]?key/i, hint: "private key material" },
  { match: /credentials?\b/i, hint: "credential bundle" },
  { match: /secrets?\b/i, hint: "secret material" },
];

function classifySecret(path: string): string | null {
  for (const { match, hint } of SECRET_HINTS) {
    if (match.test(path)) return hint;
  }
  return null;
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 4) return; // bound it
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out, depth + 1);
    } else if (st.isFile()) {
      out.push(full);
    }
  }
}

async function gatewayState(): Promise<GatewayState> {
  // Try `systemctl --user status openclaw-gateway.service` lightly.
  const proc = Bun.spawn(
    [
      "sh",
      "-c",
      "systemctl --user is-enabled openclaw-gateway.service 2>/dev/null",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = (await new Response(proc.stdout).text()).trim();
  const registered = stdout === "enabled" || stdout === "static";
  return {
    registered,
    service: registered ? "openclaw-gateway.service" : null,
    details: registered
      ? "OpenClaw gateway service is enabled at user level. Not migrating; flagged for awareness."
      : "No user-level OpenClaw gateway service detected.",
  };
}

// --- Vellum-side implementation ---

async function inventoryVellum(): Promise<void> {
  const warnings: string[] = [];
  const home = findOpenclawHome();
  const cliAvailable = await openclawCliAvailable();
  const mappings = parseMapping();

  if (mappings.length === 0) {
    warnings.push(
      'No mappings loaded from references/mapping.md. Every key will be flagged as `mapping: "unknown"`.',
    );
  }

  // 1. Config entries: try every known source key via the CLI.
  const config: ConfigEntry[] = [];
  if (cliAvailable) {
    for (const m of mappings) {
      const value = await getOpenclawConfig(m.source);
      if (value === null) continue;
      config.push({
        source_key: m.source,
        value,
        mapping: m.destination ? "known" : "unknown",
        destination: m.destination ?? undefined,
        notes: m.notes,
      });
    }
  } else {
    warnings.push(
      "`openclaw` CLI is not available. Config inventory is skipped; consider asking the user to read their OpenClaw config file directly.",
    );
  }

  // 2. Secret-shaped files under the home dir.
  const secret_paths: SecretEntry[] = [];
  if (home) {
    const files: string[] = [];
    walk(home, files);
    for (const f of files) {
      const hint = classifySecret(f);
      if (hint) {
        secret_paths.push({ path: f, hint });
      }
    }
  } else {
    warnings.push(
      "OpenClaw home directory not found; cannot scan for secret files.",
    );
  }

  // 3. Gateway state.
  const gw = await gatewayState();

  const plan: Plan = {
    config,
    secret_paths,
    gateway: gw,
    home,
    cli_available: cliAvailable,
    warnings,
  };

  // Write to a stable scratch path and also print.
  const outPath = "/tmp/openclaw-migration-plan.json";
  try {
    await Bun.write(outPath, JSON.stringify(plan, null, 2));
  } catch {
    // Non-fatal: stdout copy is the canonical artifact for the agent.
  }
  console.log(JSON.stringify(plan, null, 2));
}

async function main(): Promise<void> {
  switch (species) {
    case "vellum":
      await inventoryVellum();
      break;
    default:
      console.error(
        `Unsupported species: ${species ?? "(not set)"}. This skill currently only supports species=vellum.`,
      );
      process.exitCode = 1;
  }
}

main();
