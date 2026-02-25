import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadLatestAssistant } from "../lib/assistant-config";

// ---------------------------------------------------------------------------
// Runtime API client
// ---------------------------------------------------------------------------

function getRuntimeUrl(): string {
  const entry = loadLatestAssistant();
  if (entry?.runtimeUrl) return entry.runtimeUrl;
  return "http://localhost:7821";
}

function getBearerToken(): string | undefined {
  const entry = loadLatestAssistant();
  if (entry?.bearerToken) return entry.bearerToken;
  try {
    const tokenPath = join(
      process.env.BASE_DATA_DIR?.trim() || homedir(),
      ".vellum",
      "http-token",
    );
    if (existsSync(tokenPath)) {
      const token = readFileSync(tokenPath, "utf-8").trim();
      if (token) return token;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = getBearerToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function apiGet(path: string): Promise<unknown> {
  const url = `${getRuntimeUrl()}/v1/${path}`;
  const response = await fetch(url, { headers: buildHeaders() });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  return response.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const url = `${getRuntimeUrl()}/v1/${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  includes?: string[];
  version?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log("Usage: vellum skills <subcommand> [options]");
  console.log("");
  console.log("Subcommands:");
  console.log("  list                           List available catalog skills");
  console.log(
    "  install <skill-id> [--overwrite]  Install a skill from the catalog",
  );
  console.log("");
  console.log("Options:");
  console.log("  --json    Machine-readable JSON output");
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function skills(): Promise<void> {
  const args = process.argv.slice(3);
  const subcommand = args[0];
  const json = hasFlag(args, "--json");

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "list": {
      const data = (await apiGet("skills")) as {
        ok: boolean;
        skills: CatalogSkill[];
      };

      if (json) {
        console.log(JSON.stringify(data));
        return;
      }

      if (data.skills.length === 0) {
        console.log("No skills available in the catalog.");
        return;
      }

      console.log(`Available skills (${data.skills.length}):\n`);
      for (const s of data.skills) {
        const emoji = s.emoji ? `${s.emoji} ` : "";
        const deps = s.includes?.length
          ? ` (requires: ${s.includes.join(", ")})`
          : "";
        console.log(`  ${emoji}${s.id}`);
        console.log(`    ${s.name} — ${s.description}${deps}`);
      }
      break;
    }

    case "install": {
      const skillId = args.find((a) => !a.startsWith("--") && a !== "install");
      if (!skillId) {
        console.error("Usage: vellum skills install <skill-id>");
        process.exit(1);
      }

      const overwrite = hasFlag(args, "--overwrite");

      try {
        const data = (await apiPost("skills/install", {
          skillId,
          overwrite,
        })) as { ok: boolean; skillId?: string; error?: string };

        if (json) {
          console.log(JSON.stringify(data));
        } else {
          console.log(`Installed skill "${data.skillId ?? skillId}".`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
          console.log(JSON.stringify({ ok: false, error: msg }));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
      }
      break;
    }

    default: {
      console.error(`Unknown skills subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
    }
  }
}
