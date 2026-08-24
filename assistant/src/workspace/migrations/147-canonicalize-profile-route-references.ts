import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("migrations/147-canonicalize-profile-route-references");

// Frozen routing vocabulary for this migration. An exact connection whose
// name collides with one of these values needs the explicit reference syntax;
// otherwise the raw value keeps meaning conventional provider resolution.
const PROVIDER_IDS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
  "vercel-ai-gateway",
  "openai-compatible",
  "minimax",
  "atlascloud",
  "together",
  "litellm",
  "baseten",
  "poolside",
  "vellum",
  "chatgpt",
]);
const ROUTING_IDENTITIES = new Set(["vellum", "chatgpt"]);
const MANAGED_ROUTABLE = new Set([
  "openai",
  "anthropic",
  "gemini",
  "fireworks",
  "together",
]);
const CONNECTION_REFERENCE_PREFIX = "connection:";

export const canonicalizeProfileRouteReferencesMigration: WorkspaceMigration = {
  id: "147-canonicalize-profile-route-references",
  description:
    "Represent exact profile connection selections in the provider route reference",
  retryFailedCheckpoint: true,
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    const rawText = readFileSync(configPath, "utf-8");
    let config: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      config = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const llm = asObject(config.llm);
    const profiles = llm === null ? null : asObject(llm.profiles);
    if (profiles === null || !hasLegacyOrAmbiguousRoute(profiles)) {
      return;
    }

    const rows = readConnectionRows(workspaceDir);
    if (rows === null) {
      throw new Error(
        "provider_connections is not readable; retrying route-reference canonicalization on the next run",
      );
    }

    let changed = false;
    for (const [profileName, rawEntry] of Object.entries(profiles)) {
      const entry = asObject(rawEntry);
      if (entry === null) {
        continue;
      }
      const binding = entry.provider_connection;
      const provider = entry.provider;
      if (
        typeof binding !== "string" &&
        typeof provider === "string" &&
        provider.startsWith(CONNECTION_REFERENCE_PREFIX) &&
        rows.has(provider)
      ) {
        entry.provider = providerReferenceForConnection(provider);
        changed = true;
        continue;
      }
      if (
        typeof binding !== "string" ||
        binding.length === 0 ||
        typeof provider !== "string"
      ) {
        continue;
      }

      const rowKind = rows.get(binding);
      if (rowKind === undefined) {
        log.warn(
          { profile: profileName, provider, binding, reason: "row_missing" },
          "Kept legacy profile binding because its connection row is missing",
        );
        continue;
      }
      if (!kindAgrees(rowKind, provider)) {
        log.warn(
          {
            profile: profileName,
            provider,
            binding,
            rowKind,
            reason: "kind_mismatch",
          },
          "Kept legacy profile binding because its provider facts disagree",
        );
        continue;
      }
      if (ROUTING_IDENTITIES.has(binding) && binding !== provider) {
        log.warn(
          {
            profile: profileName,
            provider,
            binding,
            reason: "identity_semantics",
          },
          "Kept legacy profile binding because collapsing it could change model routing",
        );
        continue;
      }

      entry.provider = providerReferenceForConnection(binding);
      delete entry.provider_connection;
      changed = true;
    }

    if (changed) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

function hasLegacyOrAmbiguousRoute(profiles: Record<string, unknown>): boolean {
  return Object.values(profiles).some((value) => {
    const entry = asObject(value);
    return (
      entry !== null &&
      ((typeof entry.provider_connection === "string" &&
        entry.provider_connection.length > 0) ||
        (typeof entry.provider === "string" &&
          entry.provider.startsWith(CONNECTION_REFERENCE_PREFIX)))
    );
  });
}

function providerReferenceForConnection(connectionName: string): string {
  if (
    PROVIDER_IDS.has(connectionName) ||
    connectionName.startsWith(CONNECTION_REFERENCE_PREFIX)
  ) {
    return `${CONNECTION_REFERENCE_PREFIX}${encodeURIComponent(connectionName)}`;
  }
  return connectionName;
}

function kindAgrees(rowKind: string, provider: string): boolean {
  if (rowKind === provider) {
    return true;
  }
  if (rowKind === "chatgpt") {
    return provider === "openai";
  }
  if (rowKind === "vellum") {
    return MANAGED_ROUTABLE.has(provider);
  }
  return false;
}

function readConnectionRows(workspaceDir: string): Map<string, string> | null {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    return new Map();
  }
  let db: Database;
  try {
    db = new Database(dbPath);
  } catch {
    return null;
  }
  try {
    const rows = db
      .query("SELECT name, provider FROM provider_connections")
      .all() as Array<{ name: string; provider: string }>;
    return new Map(rows.map((row) => [row.name, row.provider]));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
