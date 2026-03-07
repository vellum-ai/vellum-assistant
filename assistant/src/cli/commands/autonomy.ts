import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Command } from "commander";

import { getCliLogger } from "../../util/logger.js";

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

function getJson(cmd: Command): boolean {
  let c: Command | null = cmd;
  while (c) {
    if ((c.opts() as { json?: boolean }).json) return true;
    c = c.parent;
  }
  return false;
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
    .description("View and configure autonomy tiers")
    .option("--json", "Machine-readable JSON output");

  autonomy.addHelpText(
    "after",
    `
Autonomy tiers control how independently the assistant acts on each message:

  auto     Assistant acts independently — sends messages, executes actions
           without asking for permission.
  draft    Assistant creates drafts for your approval before sending or
           executing. You review and confirm each action.
  notify   Assistant notifies you about incoming messages and events but
           does not act or draft. Purely informational.

Resolution order (first match wins):
  1. Contact override   — per-contact tier set via --contact
  2. Category override  — per-category tier set via --category
  3. Channel default    — per-channel tier set via --channel
  4. Global default     — the fallback tier set via --default

Config is stored in <data-dir>/.vellum/workspace/autonomy.json, where
<data-dir> is the BASE_DATA_DIR environment variable (defaults to $HOME).

Examples:
  $ assistant autonomy get
  $ assistant autonomy set --default draft
  $ assistant autonomy set --channel telegram --tier auto`,
  );

  autonomy
    .command("get")
    .description("Show current autonomy configuration")
    .addHelpText(
      "after",
      `
Prints the full autonomy configuration: the global default tier, per-channel
defaults, category overrides, and contact overrides. Sections with no entries
are shown as "(none)".

Pass --json (on the parent command) for machine-readable output containing
the complete config object.

Examples:
  $ assistant autonomy get
  $ assistant autonomy --json get`,
    )
    .action((_opts: Record<string, unknown>, cmd: Command) => {
      const json = getJson(cmd);
      const config = loadConfig();
      if (json) {
        outputJson({ ok: true, config });
      } else {
        process.stdout.write("Autonomy configuration:\n\n");
        process.stdout.write(formatConfigForHuman(config) + "\n");
      }
    });

  autonomy
    .command("set")
    .description("Set autonomy tier for default, channel, category, or contact")
    .option("--default <tier>", "Set the global default tier")
    .option("--channel <channel>", "Channel to configure")
    .option("--category <category>", "Category to configure")
    .option("--contact <contactId>", "Contact to configure")
    .option("--tier <tier>", "Tier to set (auto, draft, notify)")
    .addHelpText(
      "after",
      `
Four targeting modes — provide one of the following per invocation. If multiple
are given, the first match is applied in this priority order:

  --default <tier>                Set the global default tier. The <tier>
                                  value is the argument itself — do not
                                  combine with --tier.
  --channel <channel> --tier <t>  Set the default tier for a specific channel.
  --category <cat> --tier <t>     Set the tier override for a message category.
  --contact <id> --tier <t>       Set the tier override for a specific contact.

Valid tier values: auto, draft, notify.

Each call merges into the existing config — it does not replace other entries.
For example, setting a channel default leaves all other channel defaults,
category overrides, and contact overrides intact.

Examples:
  $ assistant autonomy set --default draft
  $ assistant autonomy set --channel telegram --tier auto
  $ assistant autonomy set --category billing --tier notify
  $ assistant autonomy set --contact c_8f3a1b2d --tier draft`,
    )
    .action(
      (
        opts: {
          default?: string;
          channel?: string;
          category?: string;
          contact?: string;
          tier?: string;
        },
        cmd: Command,
      ) => {
        const json = getJson(cmd);

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
          if (json) {
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
          if (json) {
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
          if (json) {
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
          if (json) {
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
