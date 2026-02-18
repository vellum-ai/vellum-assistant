/**
 * CLI command group: `vellum autonomy`
 *
 * View and configure autonomy tiers that govern what runs unsupervised
 * per channel, category, or contact.
 */

import { Command } from 'commander';
import {
  getAutonomyConfig,
  setAutonomyConfig,
  AUTONOMY_TIERS,
} from '../autonomy/index.js';
import type { AutonomyTier } from '../autonomy/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(data: unknown, json: boolean): void {
  process.stdout.write(
    json ? JSON.stringify(data) + '\n' : JSON.stringify(data, null, 2) + '\n',
  );
}

function exitError(message: string): void {
  output({ ok: false, error: message }, true);
  process.exitCode = 1;
}

function getJson(cmd: Command): boolean {
  let c: Command | null = cmd;
  while (c) {
    if ((c.opts() as { json?: boolean }).json) return true;
    c = c.parent;
  }
  return false;
}

function isValidTier(value: string): value is AutonomyTier {
  return AUTONOMY_TIERS.includes(value as AutonomyTier);
}

function formatConfigForHuman(): string {
  const config = getAutonomyConfig();
  const lines: string[] = [
    `  Default tier: ${config.defaultTier}`,
  ];

  const channelEntries = Object.entries(config.channelDefaults);
  if (channelEntries.length > 0) {
    lines.push('  Channel defaults:');
    for (const [channel, tier] of channelEntries) {
      lines.push(`    ${channel}: ${tier}`);
    }
  } else {
    lines.push('  Channel defaults: (none)');
  }

  const categoryEntries = Object.entries(config.categoryOverrides);
  if (categoryEntries.length > 0) {
    lines.push('  Category overrides:');
    for (const [category, tier] of categoryEntries) {
      lines.push(`    ${category}: ${tier}`);
    }
  } else {
    lines.push('  Category overrides: (none)');
  }

  const contactEntries = Object.entries(config.contactOverrides);
  if (contactEntries.length > 0) {
    lines.push('  Contact overrides:');
    for (const [contactId, tier] of contactEntries) {
      lines.push(`    ${contactId}: ${tier}`);
    }
  } else {
    lines.push('  Contact overrides: (none)');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerAutonomyCommand(program: Command): void {
  const autonomy = program
    .command('autonomy')
    .description('View and configure autonomy tiers')
    .option('--json', 'Machine-readable JSON output');

  autonomy
    .command('get')
    .description('Show current autonomy configuration')
    .action((_opts: unknown, cmd: Command) => {
      const config = getAutonomyConfig();
      const json = getJson(cmd);

      if (json) {
        output({ ok: true, config }, true);
      } else {
        process.stdout.write('Autonomy configuration:\n\n');
        process.stdout.write(formatConfigForHuman() + '\n');
      }
    });

  autonomy
    .command('set')
    .description('Set autonomy tier for a channel, category, contact, or the global default')
    .option('--default <tier>', 'Set the global default tier')
    .option('--channel <channel>', 'Channel to configure (use with --tier)')
    .option('--category <category>', 'Category to configure (use with --tier)')
    .option('--contact <contactId>', 'Contact ID to configure (use with --tier)')
    .option('--tier <tier>', 'Autonomy tier to set (auto, draft, notify)')
    .action((opts: {
      default?: string;
      channel?: string;
      category?: string;
      contact?: string;
      tier?: string;
    }, cmd: Command) => {
      const json = getJson(cmd);

      // Set global default
      if (opts.default) {
        if (!isValidTier(opts.default)) {
          exitError(`Invalid tier "${opts.default}". Must be one of: ${AUTONOMY_TIERS.join(', ')}`);
          return;
        }
        const config = setAutonomyConfig({ defaultTier: opts.default });
        if (json) {
          output({ ok: true, config }, true);
        } else {
          process.stdout.write(`Set global default tier to "${opts.default}".\n`);
        }
        return;
      }

      // All other options require --tier
      if (!opts.tier) {
        exitError('Missing --tier. Use --tier <auto|draft|notify>.');
        return;
      }
      if (!isValidTier(opts.tier)) {
        exitError(`Invalid tier "${opts.tier}". Must be one of: ${AUTONOMY_TIERS.join(', ')}`);
        return;
      }

      if (opts.channel) {
        const config = setAutonomyConfig({
          channelDefaults: { [opts.channel]: opts.tier },
        });
        if (json) {
          output({ ok: true, config }, true);
        } else {
          process.stdout.write(`Set channel "${opts.channel}" default to "${opts.tier}".\n`);
        }
        return;
      }

      if (opts.category) {
        const config = setAutonomyConfig({
          categoryOverrides: { [opts.category]: opts.tier },
        });
        if (json) {
          output({ ok: true, config }, true);
        } else {
          process.stdout.write(`Set category "${opts.category}" override to "${opts.tier}".\n`);
        }
        return;
      }

      if (opts.contact) {
        const config = setAutonomyConfig({
          contactOverrides: { [opts.contact]: opts.tier },
        });
        if (json) {
          output({ ok: true, config }, true);
        } else {
          process.stdout.write(`Set contact "${opts.contact}" override to "${opts.tier}".\n`);
        }
        return;
      }

      exitError('Specify one of: --default <tier>, --channel <channel> --tier <tier>, --category <category> --tier <tier>, or --contact <contactId> --tier <tier>.');
    });
}
