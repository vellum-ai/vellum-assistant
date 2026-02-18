/**
 * CLI command group: `vellum contacts`
 *
 * Manage the contact graph — list, inspect, and merge contacts.
 */

import { Command } from 'commander';
import { initializeDb } from '../memory/db.js';
import {
  listContacts,
  getContact,
  mergeContacts,
} from '../contacts/contact-store.js';
import type { ContactWithChannels } from '../contacts/types.js';

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

function formatContactForHuman(c: ContactWithChannels): string {
  const lines = [
    `  ID:           ${c.id}`,
    `  Name:         ${c.displayName}`,
    `  Relationship: ${c.relationship ?? '(none)'}`,
    `  Importance:   ${c.importance.toFixed(2)}`,
    `  Response:     ${c.responseExpectation ?? '(none)'}`,
    `  Tone:         ${c.preferredTone ?? '(none)'}`,
    `  Interactions: ${c.interactionCount}`,
  ];
  if (c.lastInteraction) {
    lines.push(`  Last seen:    ${new Date(c.lastInteraction).toISOString()}`);
  }
  if (c.channels.length > 0) {
    lines.push('  Channels:');
    for (const ch of c.channels) {
      const primary = ch.isPrimary ? ' (primary)' : '';
      lines.push(`    - ${ch.type}: ${ch.address}${primary}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerContactsCommand(program: Command): void {
  const contacts = program
    .command('contacts')
    .description('Manage the contact graph')
    .option('--json', 'Machine-readable JSON output');

  contacts
    .command('list')
    .description('List all contacts')
    .option('--limit <n>', 'Max contacts to show', '50')
    .action((opts: { limit: string }, cmd: Command) => {
      initializeDb();
      const limit = parseInt(opts.limit, 10) || 50;
      const results = listContacts(limit);
      const json = getJson(cmd);

      if (json) {
        output({ ok: true, contacts: results }, true);
        return;
      }

      if (results.length === 0) {
        process.stdout.write('No contacts found.\n');
        return;
      }

      process.stdout.write(`Contacts (${results.length}):\n\n`);
      for (const c of results) {
        process.stdout.write(formatContactForHuman(c) + '\n\n');
      }
    });

  contacts
    .command('get <id>')
    .description('Get a contact by ID')
    .action((id: string, _opts: unknown, cmd: Command) => {
      initializeDb();
      const contact = getContact(id);
      const json = getJson(cmd);

      if (!contact) {
        if (json) {
          exitError(`Contact "${id}" not found`);
        } else {
          process.stdout.write(`Contact "${id}" not found.\n`);
          process.exitCode = 1;
        }
        return;
      }

      if (json) {
        output({ ok: true, contact }, true);
      } else {
        process.stdout.write(formatContactForHuman(contact) + '\n');
      }
    });

  contacts
    .command('merge <keepId> <mergeId>')
    .description('Merge two contacts (merge second into first, delete second)')
    .action((keepId: string, mergeId: string, _opts: unknown, cmd: Command) => {
      initializeDb();
      const json = getJson(cmd);

      try {
        const merged = mergeContacts(keepId, mergeId);
        if (json) {
          output({ ok: true, contact: merged }, true);
        } else {
          process.stdout.write(`Merged contact "${mergeId}" into "${keepId}".\n\n`);
          process.stdout.write(formatContactForHuman(merged) + '\n');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
          exitError(msg);
        } else {
          process.stdout.write(`Error: ${msg}\n`);
          process.exitCode = 1;
        }
      }
    });
}
