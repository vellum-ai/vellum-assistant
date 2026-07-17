import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { contactsHelp } from "./contacts.help.js";

// ---------------------------------------------------------------------------
// IPC response shapes
// ---------------------------------------------------------------------------

// ACL fields (role, status, policy) are gateway-owned and not hydrated by the
// daemon-native filtered reads (`--query`/`--channel-address`/`--channel-type`),
// so they are optional here. The unfiltered default read carries them.
interface ContactChannel {
  id: string;
  contactId: string;
  type: string;
  address: string;
  status?: string;
  policy?: string;
  isPrimary?: boolean;
  revokedReason?: string | null;
  blockedReason?: string | null;
}

interface ContactWithChannels {
  id: string;
  displayName: string;
  role?: string;
  contactType: string;
  notes?: string;
  principalId?: string;
  createdAt: string | number;
  updatedAt: string | number;
  interactionCount: number | null;
  channels: ContactChannel[];
}

interface AssistantContactMetadata {
  species: string;
  metadata?: Record<string, unknown> & { assistantId?: string };
}

interface ContactPromptResult {
  ok: boolean;
  error?: string;
  channelType?: string;
  address?: string;
  channelId?: string;
  contactId?: string;
}

// ---------------------------------------------------------------------------
// Human-readable formatters
// ---------------------------------------------------------------------------

function formatContactTable(contacts: ContactWithChannels[]): string {
  const headers = ["ID", "NAME", "ROLE", "CHANNELS"];
  const rows = contacts.map((c) => [
    c.id,
    c.displayName,
    `${c.role ?? "—"}/${c.contactType}`,
    String(c.channels.length),
  ]);

  // Pad all columns
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)),
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const headerLine = headers.map((h, i) => pad(h, widths[i])).join("  ");
  const separator = widths.map((w) => "─".repeat(w)).join("  ");

  const dataLines = rows.map((row) =>
    row.map((cell, i) => pad(cell, widths[i])).join("  "),
  );

  return [headerLine, separator, ...dataLines].join("\n");
}

function formatChannelTable(channels: ContactChannel[]): string {
  const headers = ["ID", "TYPE", "ADDRESS", "FLAGS"];
  const rows = channels.map((ch) => {
    const flags = [
      ch.isPrimary ? "primary" : null,
      ch.status && ch.status !== "active" ? ch.status : null,
      ch.policy && ch.policy !== "allow" ? ch.policy : null,
    ]
      .filter(Boolean)
      .join(", ");
    return [ch.id, ch.type, ch.address, flags];
  });

  // Pad all columns except the last (FLAGS can be empty)
  const fixedCols = headers.length - 1;
  const widths = headers
    .slice(0, fixedCols)
    .map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));

  const pad = (s: string, w: number) => s.padEnd(w);
  const headerLine = [
    ...headers.slice(0, fixedCols).map((h, i) => pad(h, widths[i])),
    headers[fixedCols],
  ].join("  ");
  const separator = [
    ...widths.map((w) => "─".repeat(w)),
    "─".repeat(headers[fixedCols].length),
  ].join("  ");

  const dataLines = rows.map((row) =>
    [
      ...row.slice(0, fixedCols).map((cell, i) => pad(cell, widths[i])),
      row[fixedCols],
    ].join("  "),
  );

  return [headerLine, separator, ...dataLines].map((l) => `  ${l}`).join("\n");
}

function formatContactDetail(
  c: ContactWithChannels,
  assistantMeta?: AssistantContactMetadata,
): string {
  const lines: string[] = [];
  lines.push(`ID:           ${c.id}`);
  lines.push(`Display Name: ${c.displayName}`);
  if (c.role) lines.push(`Role:         ${c.role}`);
  lines.push(`Type:         ${c.contactType}`);
  if (c.notes) lines.push(`Notes:        ${c.notes}`);
  if (c.principalId) lines.push(`Principal:    ${c.principalId}`);
  lines.push(`Created:      ${new Date(c.createdAt).toISOString()}`);
  lines.push(`Updated:      ${new Date(c.updatedAt).toISOString()}`);
  lines.push(`Interactions: ${c.interactionCount ?? 0}`);
  if (c.channels.length > 0) {
    lines.push("");
    lines.push("Channels:");
    lines.push(formatChannelTable(c.channels));
  }
  if (assistantMeta?.metadata && "assistantId" in assistantMeta.metadata) {
    lines.push("");
    lines.push(
      `Assistant:    ${assistantMeta.species} ${assistantMeta.metadata.assistantId}`,
    );
  }
  return lines.join("\n");
}

function writeError(cmd: Command, message: string): void {
  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: false, error: message });
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
}

export function registerContactsCommand(program: Command): void {
  registerCommand(program, {
    name: contactsHelp.name,
    transport: "ipc",
    description: contactsHelp.description,
    build: (contacts) => {
      applyCommandHelp(contacts, contactsHelp);

      // -----------------------------------------------------------------------
      // list
      // -----------------------------------------------------------------------

      subcommand(contacts, "list").action(
        async (
          opts: {
            role?: string;
            limit?: string;
            query?: string;
            channelAddress?: string;
            channelType?: string;
          },
          cmd: Command,
        ) => {
          const r = await cliIpcCall<{
            ok: boolean;
            contacts: ContactWithChannels[];
          }>("listContacts", {
            queryParams: {
              ...(opts.role && { role: opts.role }),
              ...(opts.limit && { limit: opts.limit }),
              ...(opts.query && { query: opts.query }),
              ...(opts.channelAddress && {
                channelAddress: opts.channelAddress,
              }),
              ...(opts.channelType && { channelType: opts.channelType }),
            },
          });

          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );

          const results = r.result!.contacts;
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, contacts: results });
          } else if (results.length === 0) {
            process.stdout.write("No contacts found.\n");
          } else {
            process.stdout.write(formatContactTable(results) + "\n");
            process.stdout.write(`\n${results.length} contact(s)\n`);
          }
        },
      );

      // -----------------------------------------------------------------------
      // get
      // -----------------------------------------------------------------------

      subcommand(contacts, "get").action(
        async (id: string, _opts: unknown, cmd: Command) => {
          const r = await cliIpcCall<{
            ok: boolean;
            contact: ContactWithChannels;
            assistantMetadata?: AssistantContactMetadata;
          }>("getContact", {
            pathParams: { id },
          });

          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );

          const { contact, assistantMetadata } = r.result!;
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, {
              ok: true,
              contact,
              assistantMetadata: assistantMetadata ?? undefined,
            });
          } else {
            process.stdout.write(
              formatContactDetail(contact, assistantMetadata ?? undefined) +
                "\n",
            );
          }
        },
      );

      // -----------------------------------------------------------------------
      // prompt
      // -----------------------------------------------------------------------

      subcommand(contacts, "prompt").action(
        async (
          opts: {
            channel?: string;
            placeholder?: string;
            role?: string;
            label?: string;
            description?: string;
            timeout?: string;
          },
          cmd: Command,
        ) => {
          const timeoutMs = opts.timeout ? parseInt(opts.timeout, 10) : 310_000;
          const r = await cliIpcCall<ContactPromptResult>(
            "contacts_prompt",
            {
              body: {
                channel: opts.channel,
                placeholder: opts.placeholder,
                role: opts.role ?? "unknown",
                label: opts.label,
                description: opts.description,
              },
            },
            { timeoutMs },
          );

          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );

          if (!r.result?.ok) {
            writeError(cmd, r.result?.error ?? "Contact prompt failed");
            process.exitCode = 1;
            return;
          }

          const result = r.result;
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, result);
          } else {
            process.stdout.write(
              `Registered ${result.channelType} channel: ${result.address}\n` +
                `  Channel ID: ${result.channelId}\n` +
                `  Contact ID: ${result.contactId}\n` +
                `  Status:     unverified\n`,
            );
          }
        },
      );

      // -----------------------------------------------------------------------
      // channels
      // -----------------------------------------------------------------------

      const channelsCmds = subcommand(contacts, "channels");

      subcommand(channelsCmds, "update-status").action(
        async (
          channelId: string,
          opts: {
            status?: string;
            policy?: string;
            reason?: string;
          },
          cmd: Command,
        ) => {
          if (!opts.status && !opts.policy) {
            writeError(
              cmd,
              "At least one of --status or --policy must be provided",
            );
            process.exitCode = 1;
            return;
          }

          const r = await cliIpcCall<{
            ok: boolean;
            contact?: ContactWithChannels;
          }>("updateContactChannel", {
            pathParams: { contactChannelId: channelId },
            body: {
              status: opts.status,
              policy: opts.policy,
              reason: opts.reason,
            },
          });

          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, r.result);
          } else {
            process.stdout.write(`Updated channel ${channelId}\n`);
          }
        },
      );

      // -----------------------------------------------------------------------
      // invites
      // -----------------------------------------------------------------------

      // Invite subcommands dispatch daemon route operationIds that mirror the
      // gateway wire names in INVITES_IPC_METHODS (@vellumai/gateway-client) —
      // kept as literals to avoid pulling the gateway-client contract module
      // into the CLI here.
      const invites = subcommand(contacts, "invites");

      subcommand(invites, "list").action(
        async (
          opts: { sourceChannel?: string; status?: string },
          cmd: Command,
        ) => {
          const r = await cliIpcCall<{
            ok: boolean;
            invites: Array<{
              id: string;
              sourceChannel: string;
              status: string;
              token?: string;
            }>;
          }>("invites_list", {
            queryParams: {
              ...(opts.sourceChannel && {
                sourceChannel: opts.sourceChannel,
              }),
              ...(opts.status && { status: opts.status }),
            },
          });

          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );

          const invitesList = r.result!.invites;
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, invites: invitesList });
          } else if (invitesList.length === 0) {
            process.stdout.write("No invites found.\n");
          } else {
            for (const inv of invitesList) {
              const parts = [
                inv.id,
                inv.sourceChannel,
                inv.status,
                inv.token ? `token:${inv.token}` : "",
              ].filter(Boolean);
              process.stdout.write(parts.join("  ") + "\n");
            }
            process.stdout.write(`\n${invitesList.length} invite(s)\n`);
          }
        },
      );

      subcommand(invites, "create").action(
        async (
          opts: {
            sourceChannel: string;
            note?: string;
            maxUses?: string;
            expiresInMs?: string;
            expectedExternalUserId?: string;
            contactId: string;
          },
          cmd: Command,
        ) => {
          const maxUses = opts.maxUses ? Number(opts.maxUses) : undefined;
          if (maxUses !== undefined && !Number.isFinite(maxUses)) {
            writeError(
              cmd,
              `--max-uses must be a number, got: ${opts.maxUses}`,
            );
            process.exitCode = 1;
            return;
          }
          const expiresInMs = opts.expiresInMs
            ? Number(opts.expiresInMs)
            : undefined;
          if (expiresInMs !== undefined && !Number.isFinite(expiresInMs)) {
            writeError(
              cmd,
              `--expires-in-ms must be a number, got: ${opts.expiresInMs}`,
            );
            process.exitCode = 1;
            return;
          }

          const r = await cliIpcCall<{
            ok: boolean;
            invite: {
              id: string;
              sourceChannel: string;
              token?: string;
            };
          }>("invites_create", {
            body: {
              sourceChannel: opts.sourceChannel,
              note: opts.note,
              maxUses,
              expiresInMs,
              expectedExternalUserId: opts.expectedExternalUserId,
              contactId: opts.contactId,
            },
          });

          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );

          const { invite } = r.result!;
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, invite });
          } else {
            process.stdout.write(
              `Created invite ${invite.id} (${invite.sourceChannel})\n`,
            );
            if (invite.token) process.stdout.write(`Token: ${invite.token}\n`);
          }
        },
      );

      subcommand(invites, "revoke").action(
        async (inviteId: string, _opts: unknown, cmd: Command) => {
          const r = await cliIpcCall<{
            ok: boolean;
            invite: unknown;
          }>("invites_revoke", {
            pathParams: { id: inviteId },
          });

          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, invite: r.result!.invite });
          } else {
            process.stdout.write(`Revoked invite ${inviteId}\n`);
          }
        },
      );

      subcommand(invites, "redeem").action(
        async (
          opts: {
            token?: string;
            sourceChannel?: string;
            externalUserId?: string;
            externalChatId?: string;
            code?: string;
            callerExternalUserId?: string;
            assistantId?: string;
          },
          cmd: Command,
        ) => {
          if (opts.code && !opts.callerExternalUserId) {
            writeError(
              cmd,
              "--caller-external-user-id is required for voice code redemption",
            );
            process.exitCode = 1;
            return;
          }

          const r = await cliIpcCall<{
            ok: boolean;
            // Token path
            invite?: unknown;
            // Voice path
            type?: string;
            memberId?: string;
            inviteId?: string;
          }>("invites_redeem", {
            body: {
              token: opts.token,
              sourceChannel: opts.sourceChannel,
              externalUserId: opts.externalUserId,
              externalChatId: opts.externalChatId,
              code: opts.code,
              callerExternalUserId: opts.callerExternalUserId,
              assistantId: opts.assistantId,
            },
          });

          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );

          const result = r.result!;
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, result);
          } else if (result.type) {
            // Voice code path
            process.stdout.write(
              `Redeemed (${result.type}), member: ${result.memberId}\n`,
            );
          } else {
            // Token path
            process.stdout.write("Invite redeemed.\n");
          }
        },
      );
    },
  });
}
