import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Command } from "commander";

import { getCliLogger } from "../util/logger.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type AutonomyTier = "auto" | "draft" | "notify";

const AUTONOMY_TIERS: readonly AutonomyTier[] = ["auto", "draft", "notify"];

interface AutonomyConfig {
  defaultTier: AutonomyTier;
  channelDefaults: Record<string, AutonomyTier>;
  categoryOverrides: Record<string, AutonomyTier>;
  contactOverrides: Record<string, AutonomyTier>;
}

const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  defaultTier: "notify",
  channelDefaults: {},
  categoryOverrides: {},
  contactOverrides: {},
};

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

function getConfigPath(): string {
  const root = join(process.env.BASE_DATA_DIR?.trim() || homedir(), ".vellum");
  return join(root, "workspace", "autonomy.json");
}

function isValidTier(value: unknown): value is AutonomyTier {
  return (
    typeof value === "string" && AUTONOMY_TIERS.includes(value as AutonomyTier)
  );
}

function validateTierRecord(raw: unknown): Record<string, AutonomyTier> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, AutonomyTier> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isValidTier(value)) {
      result[key] = value;
    }
  }
  return result;
}

function validateConfig(raw: unknown): AutonomyConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return structuredClone(DEFAULT_AUTONOMY_CONFIG);
  }
  const obj = raw as Record<string, unknown>;
  return {
    defaultTier: isValidTier(obj.defaultTier)
      ? obj.defaultTier
      : DEFAULT_AUTONOMY_CONFIG.defaultTier,
    channelDefaults: validateTierRecord(obj.channelDefaults),
    categoryOverrides: validateTierRecord(obj.categoryOverrides),
    contactOverrides: validateTierRecord(obj.contactOverrides),
  };
}

function loadConfig(): AutonomyConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return structuredClone(DEFAULT_AUTONOMY_CONFIG);
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    return validateConfig(JSON.parse(raw));
  } catch {
    log.error("Warning: failed to parse autonomy config; using defaults");
    return structuredClone(DEFAULT_AUTONOMY_CONFIG);
  }
}

function saveConfig(config: AutonomyConfig): void {
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

function applyUpdate(updates: Partial<AutonomyConfig>): AutonomyConfig {
  const current = loadConfig();
  if (updates.defaultTier !== undefined) {
    current.defaultTier = updates.defaultTier;
  }
  if (updates.channelDefaults !== undefined) {
    current.channelDefaults = {
      ...current.channelDefaults,
      ...updates.channelDefaults,
    };
  }
  if (updates.categoryOverrides !== undefined) {
    current.categoryOverrides = {
      ...current.categoryOverrides,
      ...updates.categoryOverrides,
    };
  }
  if (updates.contactOverrides !== undefined) {
    current.contactOverrides = {
      ...current.contactOverrides,
      ...updates.contactOverrides,
    };
  }
  saveConfig(current);
  return current;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function formatConfigForHuman(config: AutonomyConfig): string {
  const lines: string[] = [`  Default tier: ${config.defaultTier}`];

  const channelEntries = Object.entries(config.channelDefaults);
  if (channelEntries.length > 0) {
    lines.push("  Channel defaults:");
    for (const [channel, tier] of channelEntries) {
      lines.push(`    ${channel}: ${tier}`);
    }
  } else {
    lines.push("  Channel defaults: (none)");
  }

  const categoryEntries = Object.entries(config.categoryOverrides);
  if (categoryEntries.length > 0) {
    lines.push("  Category overrides:");
    for (const [category, tier] of categoryEntries) {
      lines.push(`    ${category}: ${tier}`);
    }
  } else {
    lines.push("  Category overrides: (none)");
  }

  const contactEntries = Object.entries(config.contactOverrides);
  if (contactEntries.length > 0) {
    lines.push("  Contact overrides:");
    for (const [contactId, tier] of contactEntries) {
      lines.push(`    ${contactId}: ${tier}`);
    }
  } else {
    lines.push("  Contact overrides: (none)");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerAutonomyCommand(program: Command): void {
  const autonomy = program
    .command("autonomy")
    .description("View and configure autonomy tiers");

  autonomy
    .command("get")
    .description("Show current autonomy configuration")
    .option("--json", "Machine-readable JSON output")
    .action((opts: { json?: boolean }) => {
      const config = loadConfig();
      if (opts.json) {
        outputJson({ ok: true, config });
      } else {
        process.stdout.write("Autonomy configuration:\n\n");
        process.stdout.write(formatConfigForHuman(config) + "\n");
      }
    });

  autonomy
    .command("set")
    .description("Set autonomy tier for default, channel, category, or contact")
    .option("--json", "Machine-readable JSON output")
    .option("--default <tier>", "Set the global default tier")
    .option("--channel <channel>", "Channel to configure")
    .option("--category <category>", "Category to configure")
    .option("--contact <contactId>", "Contact to configure")
    .option("--tier <tier>", "Tier to set (auto, draft, notify)")
    .action(
      (opts: {
        json?: boolean;
        default?: string;
        channel?: string;
        category?: string;
        contact?: string;
        tier?: string;
      }) => {
        if (opts.default) {
          if (!isValidTier(opts.default)) {
            outputJson({
              ok: false,
              error: `Invalid tier "${opts.default}". Must be one of: ${AUTONOMY_TIERS.join(", ")}`,
            });
            process.exitCode = 1;
            return;
          }
          const config = applyUpdate({ defaultTier: opts.default });
          if (opts.json) {
            outputJson({ ok: true, config });
          } else {
            log.info(`Set global default tier to "${opts.default}".`);
          }
          return;
        }

        if (!opts.tier) {
          outputJson({
            ok: false,
            error: "Missing --tier. Use --tier <auto|draft|notify>.",
          });
          process.exitCode = 1;
          return;
        }
        if (!isValidTier(opts.tier)) {
          outputJson({
            ok: false,
            error: `Invalid tier "${opts.tier}". Must be one of: ${AUTONOMY_TIERS.join(", ")}`,
          });
          process.exitCode = 1;
          return;
        }

        if (opts.channel) {
          const config = applyUpdate({
            channelDefaults: { [opts.channel]: opts.tier },
          });
          if (opts.json) {
            outputJson({ ok: true, config });
          } else {
            log.info(
              `Set channel "${opts.channel}" default to "${opts.tier}".`,
            );
          }
          return;
        }

        if (opts.category) {
          const config = applyUpdate({
            categoryOverrides: { [opts.category]: opts.tier },
          });
          if (opts.json) {
            outputJson({ ok: true, config });
          } else {
            log.info(
              `Set category "${opts.category}" override to "${opts.tier}".`,
            );
          }
          return;
        }

        if (opts.contact) {
          const config = applyUpdate({
            contactOverrides: { [opts.contact]: opts.tier },
          });
          if (opts.json) {
            outputJson({ ok: true, config });
          } else {
            log.info(
              `Set contact "${opts.contact}" override to "${opts.tier}".`,
            );
          }
          return;
        }

        log.error(
          "Specify one of: --default <tier>, --channel <channel> --tier <tier>, " +
            "--category <category> --tier <tier>, or --contact <contactId> --tier <tier>.",
        );
        process.exitCode = 1;
      },
    );
}
