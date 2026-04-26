/**
 * Seeds the trust_rules table from the DEFAULT_COMMAND_REGISTRY.
 *
 * Walks the registry and produces one row per top-level command and one row
 * per subcommand (recursively). Uses deterministic IDs of the form
 * `default:bash:<command-slug>` so re-seeding is idempotent for unmodified
 * rules, while the three-guard upsert protects user modifications.
 */

import { DEFAULT_COMMAND_REGISTRY } from "../risk/command-registry/index.js";
import type { CommandRiskSpec } from "../risk/risk-types.js";
import type {
  TrustRuleStore,
  UpsertDefaultInput,
} from "./trust-rule-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a deterministic ID from a command pattern.
 * Spaces are replaced with hyphens: "git push" -> "default:bash:git-push"
 */
function makeId(pattern: string): string {
  return `default:bash:${pattern.replace(/ /g, "-")}`;
}

/**
 * Build a human-readable description for a registry entry.
 * Uses `spec.reason` when available, otherwise generates a default.
 */
function makeDescription(pattern: string, spec: CommandRiskSpec): string {
  if (spec.reason) {
    return `${pattern} \u2014 ${spec.reason}`;
  }
  return `${pattern} (default)`;
}

/**
 * Recursively collect upsert inputs from a CommandRiskSpec and its subcommands.
 */
function collectEntries(
  pattern: string,
  spec: CommandRiskSpec,
  results: UpsertDefaultInput[],
): void {
  // Add entry for this command/subcommand
  results.push({
    id: makeId(pattern),
    tool: "bash",
    pattern,
    risk: spec.baseRisk,
    description: makeDescription(pattern, spec),
  });

  // Recurse into subcommands
  if (spec.subcommands) {
    for (const [sub, subSpec] of Object.entries(spec.subcommands)) {
      collectEntries(`${pattern} ${sub}`, subSpec, results);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Seed the trust_rules table from DEFAULT_COMMAND_REGISTRY.
 *
 * Produces one row per top-level command and one row per subcommand
 * (recursively). Uses `store.upsertDefault()` so that:
 * - New entries are inserted
 * - Unmodified entries are updated (risk/description may change across versions)
 * - User-modified or soft-deleted entries are NOT overwritten (three-guard)
 *
 * @returns The number of entries upserted (for logging).
 */
export function seedTrustRulesFromRegistry(store: TrustRuleStore): number {
  const entries: UpsertDefaultInput[] = [];

  for (const [command, spec] of Object.entries(DEFAULT_COMMAND_REGISTRY)) {
    collectEntries(command, spec, entries);
  }

  for (const entry of entries) {
    store.upsertDefault(entry);
  }

  return entries.length;
}
