import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types & constants (ported from assistant/src/autonomy/types.ts)
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
// Config persistence (ported from assistant/src/autonomy/autonomy-store.ts)
// ---------------------------------------------------------------------------

function getConfigPath(): string {
  const root = join(
    process.env.BASE_DATA_DIR?.trim() || homedir(),
    ".vellum",
  );
  return join(root, "workspace", "autonomy.json");
}

function isValidTier(value: unknown): value is AutonomyTier {
  return (
    typeof value === "string" &&
    AUTONOMY_TIERS.includes(value as AutonomyTier)
  );
}

function validateTierRecord(raw: unknown): Record<string, AutonomyTier> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, AutonomyTier> = {};
  for (const [key, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
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
    console.error("Warning: failed to parse autonomy config; using defaults");
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

function output(data: unknown, json: boolean): void {
  process.stdout.write(
    json ? JSON.stringify(data) + "\n" : JSON.stringify(data, null, 2) + "\n",
  );
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
// Arg parsing helpers
// ---------------------------------------------------------------------------

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log("Usage: vellum autonomy <subcommand> [options]");
  console.log("");
  console.log("Subcommands:");
  console.log("  get                              Show current autonomy configuration");
  console.log("  set --default <tier>             Set the global default tier");
  console.log("  set --channel <ch> --tier <t>    Set tier for a channel");
  console.log("  set --category <cat> --tier <t>  Set tier for a category");
  console.log("  set --contact <id> --tier <t>    Set tier for a contact");
  console.log("");
  console.log("Options:");
  console.log("  --json    Machine-readable JSON output");
  console.log("");
  console.log("Tiers: auto, draft, notify");
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export function autonomy(): void {
  const args = process.argv.slice(3);
  const subcommand = args[0];
  const json = hasFlag(args, "--json");

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "get": {
      const config = loadConfig();
      if (json) {
        output({ ok: true, config }, true);
      } else {
        process.stdout.write("Autonomy configuration:\n\n");
        process.stdout.write(formatConfigForHuman(config) + "\n");
      }
      break;
    }

    case "set": {
      const defaultTier = getFlagValue(args, "--default");
      const channel = getFlagValue(args, "--channel");
      const category = getFlagValue(args, "--category");
      const contact = getFlagValue(args, "--contact");
      const tier = getFlagValue(args, "--tier");

      if (defaultTier) {
        if (!isValidTier(defaultTier)) {
          output(
            {
              ok: false,
              error: `Invalid tier "${defaultTier}". Must be one of: ${AUTONOMY_TIERS.join(", ")}`,
            },
            true,
          );
          process.exitCode = 1;
          return;
        }
        const config = applyUpdate({ defaultTier });
        if (json) {
          output({ ok: true, config }, true);
        } else {
          console.log(`Set global default tier to "${defaultTier}".`);
        }
        return;
      }

      if (!tier) {
        output(
          { ok: false, error: "Missing --tier. Use --tier <auto|draft|notify>." },
          true,
        );
        process.exitCode = 1;
        return;
      }
      if (!isValidTier(tier)) {
        output(
          {
            ok: false,
            error: `Invalid tier "${tier}". Must be one of: ${AUTONOMY_TIERS.join(", ")}`,
          },
          true,
        );
        process.exitCode = 1;
        return;
      }

      if (channel) {
        const config = applyUpdate({ channelDefaults: { [channel]: tier } });
        if (json) {
          output({ ok: true, config }, true);
        } else {
          console.log(`Set channel "${channel}" default to "${tier}".`);
        }
        return;
      }

      if (category) {
        const config = applyUpdate({
          categoryOverrides: { [category]: tier },
        });
        if (json) {
          output({ ok: true, config }, true);
        } else {
          console.log(`Set category "${category}" override to "${tier}".`);
        }
        return;
      }

      if (contact) {
        const config = applyUpdate({ contactOverrides: { [contact]: tier } });
        if (json) {
          output({ ok: true, config }, true);
        } else {
          console.log(`Set contact "${contact}" override to "${tier}".`);
        }
        return;
      }

      console.error(
        "Specify one of: --default <tier>, --channel <channel> --tier <tier>, " +
          "--category <category> --tier <tier>, or --contact <contactId> --tier <tier>.",
      );
      process.exitCode = 1;
      break;
    }

    default: {
      console.error(`Unknown autonomy subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
    }
  }
}
