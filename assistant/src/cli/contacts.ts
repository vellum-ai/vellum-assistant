import type { Command } from "commander";

import {
  getContact,
  listContacts,
  mergeContacts,
  searchContacts,
} from "../contacts/contact-store.js";
import type { ContactRole } from "../contacts/types.js";
import { initializeDb } from "../memory/db.js";
import {
  createIngressInvite,
  listIngressInvites,
} from "../runtime/invite-service.js";
import { writeOutput } from "./integrations.js";

export function registerContactsCommand(program: Command): void {
  const contacts = program
    .command("contacts")
    .description("Manage and query the contact graph")
    .option("--json", "Machine-readable compact JSON output");

  contacts
    .command("list")
    .description("List contacts")
    .option("--role <role>", "Filter by role (default: contact)", "contact")
    .option("--limit <limit>", "Maximum number of contacts to return")
    .option("--query <query>", "Search query to filter contacts")
    .action(
      async (
        opts: {
          role?: string;
          limit?: string;
          query?: string;
        },
        cmd: Command,
      ) => {
        try {
          initializeDb();
          const role = opts.role as ContactRole | undefined;
          const limit = opts.limit ? Number(opts.limit) : undefined;

          const results = opts.query
            ? searchContacts({ query: opts.query, role, limit })
            : listContacts(limit ?? 50, role);

          writeOutput(cmd, { ok: true, contacts: results });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );

  contacts
    .command("get <id>")
    .description("Get a contact by ID")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      try {
        initializeDb();
        const contact = getContact(id);
        if (!contact) {
          writeOutput(cmd, { ok: false, error: "Contact not found" });
          process.exitCode = 1;
          return;
        }
        writeOutput(cmd, { ok: true, contact });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });

  contacts
    .command("merge <keepId> <mergeId>")
    .description("Merge two contacts")
    .action(
      async (keepId: string, mergeId: string, _opts: unknown, cmd: Command) => {
        try {
          initializeDb();
          const contact = mergeContacts(keepId, mergeId);
          writeOutput(cmd, { ok: true, contact });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );

  const invites = contacts
    .command("invites")
    .description("Manage contact invites");

  invites
    .command("list")
    .description("List invites")
    .option("--source-channel <sourceChannel>", "Filter by source channel")
    .option("--status <status>", "Filter by invite status")
    .action(
      async (
        opts: { sourceChannel?: string; status?: string },
        cmd: Command,
      ) => {
        try {
          initializeDb();
          const result = listIngressInvites({
            sourceChannel: opts.sourceChannel,
            status: opts.status,
          });
          writeOutput(cmd, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );

  invites
    .command("create")
    .description("Create a new invite")
    .requiredOption(
      "--source-channel <channel>",
      "Source channel (e.g. telegram, voice, sms, email, whatsapp)",
    )
    .option("--note <note>", "Optional note")
    .option("--max-uses <n>", "Max redemptions")
    .option("--expires-in-ms <ms>", "Expiry duration in milliseconds")
    .option(
      "--contact-name <name>",
      "Contact name for personalizing instructions",
    )
    .option(
      "--expected-external-user-id <id>",
      "E.164 phone number (required for voice invites)",
    )
    .option("--friend-name <name>", "Friend name (required for voice invites)")
    .option(
      "--guardian-name <name>",
      "Guardian name (required for voice invites)",
    )
    .action(
      async (
        opts: {
          sourceChannel: string;
          note?: string;
          maxUses?: string;
          expiresInMs?: string;
          contactName?: string;
          expectedExternalUserId?: string;
          friendName?: string;
          guardianName?: string;
        },
        cmd: Command,
      ) => {
        try {
          initializeDb();
          const result = await createIngressInvite({
            sourceChannel: opts.sourceChannel,
            note: opts.note,
            maxUses: opts.maxUses ? Number(opts.maxUses) : undefined,
            expiresInMs: opts.expiresInMs
              ? Number(opts.expiresInMs)
              : undefined,
            contactName: opts.contactName,
            expectedExternalUserId: opts.expectedExternalUserId,
            friendName: opts.friendName,
            guardianName: opts.guardianName,
          });
          writeOutput(cmd, result);
          if (!result.ok) {
            process.exitCode = 1;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );
}
