import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { shouldOutputJson, writeOutput } from "../output.js";

// ---------------------------------------------------------------------------
// IPC response shapes
// ---------------------------------------------------------------------------

interface ContactChannel {
  id: string;
  contactId: string;
  type: string;
  address: string;
  status: string;
  policy: string;
  isPrimary?: boolean;
  revokedReason?: string | null;
  blockedReason?: string | null;
}

interface ContactWithChannels {
  id: string;
  displayName: string;
  role: string;
  contactType: string;
  notes?: string;
  principalId?: string;
  createdAt: string | number;
  updatedAt: string | number;
  interactionCount: number;
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
    `${c.role}/${c.contactType}`,
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
      ch.status !== "active" ? ch.status : null,
      ch.policy !== "allow" ? ch.policy : null,
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

  return [headerLine, separator, ...dataLines]
    .map((l) => `  ${l}`)
    .join("\n");
}

function formatContactDetail(
  c: ContactWithChannels,
  assistantMeta?: AssistantContactMetadata,
): string {
  const lines: string[] = [];
  lines.push(`ID:           ${c.id}`);
  lines.push(`Display Name: ${c.displayName}`);
  lines.push(`Role:         ${c.role}`);
  lines.push(`Type:         ${c.contactType}`);
  if (c.notes) lines.push(`Notes:        ${c.notes}`);
  if (c.principalId) lines.push(`Principal:    ${c.principalId}`);
  lines.push(`Created:      ${new Date(c.createdAt).toISOString()}`);
  lines.push(`Updated:      ${new Date(c.updatedAt).toISOString()}`);
  lines.push(`Interactions: ${c.interactionCount}`);
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
    name: "contacts",
    transport: "ipc",
    description: "Manage and query the contact graph",
    build: (contacts) => {
      contacts.option("--json", "Machine-readable compact JSON output");

      contacts.addHelpText(
        "after",
        `
Contacts represent people and entities the assistant interacts with. Each
contact is identified by a UUID, has a role (contact or guardian), and
can be linked to external identifiers — phone numbers,
Telegram IDs, email addresses — via channel memberships. The contact graph
is the source of truth for identity resolution across all channels.

Examples:
  $ assistant contacts list
  $ assistant contacts get abc-123
  $ assistant contacts invites list`,
      );

      // -----------------------------------------------------------------------
      // list
      // -----------------------------------------------------------------------

      contacts
        .command("list")
        .description("List contacts")
        .option(
          "--role <role>",
          "Filter by role (contact, guardian, or omit for all)",
        )
        .option("--limit <limit>", "Maximum number of contacts to return")
        .option("--query <query>", "Search query to filter contacts")
        .option(
          "--channel-address <address>",
          "Search by channel address (email, phone, handle)",
        )
        .option(
          "--channel-type <channelType>",
          "Filter by channel type (email, telegram, phone, whatsapp, slack)",
        )
        .addHelpText(
          "after",
          `
Lists contacts with optional filtering. The --role flag accepts: contact
or guardian (omit to show all). The --limit flag sets
the maximum number of results (defaults to 50).

When --query, --channel-address, or --channel-type is provided, a search
is performed. --query does full-text search across contact names and
linked external identifiers. --channel-address matches phone numbers,
emails, or handles. --channel-type filters by channel kind. These filters
can be combined. Without any search params, returns all contacts matching
the role filter.

Examples:
  $ assistant contacts list
  $ assistant contacts list --role guardian
  $ assistant contacts list --query "john" --limit 10
  $ assistant contacts list --channel-address "+15551234567"
  $ assistant contacts list --channel-type telegram
  $ assistant contacts list --query "alice" --channel-type email
  $ assistant contacts list --role guardian --json`,
        )
        .action(
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

      contacts
        .command("get <id>")
        .description("Get a contact by ID")
        .addHelpText(
          "after",
          `
Arguments:
  id   UUID of the contact to retrieve. Run 'assistant contacts list' to find IDs.

Returns the full contact record including role, display name, and all
channel memberships (phone numbers, Telegram IDs, email addresses, etc.).
For assistant-type contacts, additional assistant metadata is included.

Examples:
  $ assistant contacts get 7a3b1c2d-4e5f-6789-abcd-ef0123456789
  $ assistant contacts get abc-123 --json`,
        )
        .action(async (id: string, _opts: unknown, cmd: Command) => {
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
        });

      // -----------------------------------------------------------------------
      // prompt
      // -----------------------------------------------------------------------

      contacts
        .command("prompt")
        .description(
          "Prompt user to register a contact channel via the app UI",
        )
        .option(
          "--channel <channel>",
          "Suggested channel type hint (e.g. phone, email, telegram)",
        )
        .option(
          "--placeholder <placeholder>",
          "Placeholder text for the address input field",
        )
        .option(
          "--role <role>",
          "Intended role: guardian, trusted-contact, or unknown (default: unknown)",
        )
        .option("--label <label>", "Display label shown in the prompt UI")
        .option(
          "--description <description>",
          "Longer description shown in the prompt UI",
        )
        .option(
          "--timeout <ms>",
          "How long to wait for the user to submit (ms). Defaults to match the server-side prompt timeout.",
          String(310_000),
        )
        .addHelpText(
          "after",
          `
Opens a contact address prompt in the user's app. The user enters a channel
address (phone number, email, Telegram ID, etc.). The address is saved with
status "unverified". Verification is a separate step.

Run \`assistant contacts prompt --help\` for full option details.`,
        )
        .action(
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
              writeError(
                cmd,
                r.result?.error ?? "Contact prompt failed",
              );
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

      const channelsCmds = contacts
        .command("channels")
        .description("Manage contact channels");

      channelsCmds.addHelpText(
        "after",
        `
Channels represent external communication endpoints linked to contacts —
phone numbers, Telegram IDs, email addresses, etc. Each channel has a
status (active, pending, revoked, blocked, unverified) and a policy
(allow, deny, escalate) that controls how the assistant handles messages
from that channel.

Examples:
  $ assistant contacts channels update-status <channelId> --status revoked --reason "No longer needed"
  $ assistant contacts channels update-status <channelId> --policy deny`,
      );

      channelsCmds
        .command("update-status <channelId>")
        .description("Update a channel's status or policy")
        .option(
          "--status <status>",
          "New channel status: active, revoked, or blocked",
        )
        .option(
          "--policy <policy>",
          "New channel policy: allow, deny, or escalate",
        )
        .option("--reason <reason>", "Reason for the status change")
        .addHelpText(
          "after",
          `
Arguments:
  channelId   UUID of the contact channel to update. Run 'assistant contacts get <contactId>'
              to see a contact's channel IDs.

Updates the access-control fields on an existing channel. At least one of
--status or --policy must be provided.

When --status is "revoked", --reason is mapped to revokedReason on the
channel record. When --status is "blocked", --reason is mapped to
blockedReason. The --reason flag is ignored for other status values.

Valid --status values: active, revoked, blocked
Valid --policy values: allow, deny, escalate

Examples:
  $ assistant contacts channels update-status abc-123 --status revoked --reason "No longer needed" --json
  $ assistant contacts channels update-status abc-123 --status blocked --reason "Spam" --json
  $ assistant contacts channels update-status abc-123 --policy deny --json
  $ assistant contacts channels update-status abc-123 --status active --policy allow --json`,
        )
        .action(
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
              process.stdout.write(
                `Updated channel ${channelId}\n`,
              );
            }
          },
        );

      // -----------------------------------------------------------------------
      // invites
      // -----------------------------------------------------------------------

      const invites = contacts
        .command("invites")
        .description("Manage contact invites");

      invites.addHelpText(
        "after",
        `
Invites are tokens that grant channel access when redeemed. Each invite is
tied to a source channel (telegram, phone, email, whatsapp) and can
optionally have usage limits, expiration, and notes. When redeemed, the
invite creates a channel membership linking a contact to an external
identifier on the source channel.

Examples:
  $ assistant contacts invites list
  $ assistant contacts invites create --source-channel telegram
  $ assistant contacts invites revoke abc-123
  $ assistant contacts invites redeem --token xyz-789 --source-channel telegram --external-user-id 12345`,
      );

      invites
        .command("list", { isDefault: true })
        .description("List invites")
        .option("--source-channel <sourceChannel>", "Filter by source channel")
        .option("--status <status>", "Filter by invite status")
        .addHelpText(
          "after",
          `
Lists all invites with optional filtering by source channel or status.
Returns invite tokens, their source channels, usage counts, and expiration.

Examples:
  $ assistant contacts invites list
  $ assistant contacts invites list --source-channel telegram
  $ assistant contacts invites list --status active
  $ assistant contacts invites list --source-channel phone --json`,
        )
        .action(
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

      invites
        .command("create")
        .description("Create a new invite")
        .requiredOption(
          "--source-channel <channel>",
          "Source channel (e.g. telegram, phone, email, whatsapp)",
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
        .option(
          "--friend-name <name>",
          "Friend name (required for voice invites)",
        )
        .option(
          "--guardian-name <name>",
          "Guardian name (required for voice invites)",
        )
        .requiredOption(
          "--contact-id <id>",
          "Contact ID to bind the invite to",
        )
        .addHelpText(
          "after",
          `
Creates a new invite token for the specified source channel. The --source-channel
flag is required and must be one of: telegram, phone, email, whatsapp.

Optional fields:
  --note                        Free-text note attached to the invite
  --max-uses                    Maximum number of times the invite can be redeemed
  --expires-in-ms               Expiry duration in milliseconds from creation
  --contact-name                Name used to personalize invite instructions

Voice invites require three additional fields:
  --expected-external-user-id   E.164 phone number of the expected caller (e.g. +15551234567)
  --friend-name                 Name the contact uses for the assistant's owner
  --guardian-name                Name of the guardian associated with this invite

Examples:
  $ assistant contacts invites create --source-channel telegram --note "For Alice" --max-uses 1
  $ assistant contacts invites create --source-channel phone --expected-external-user-id "+15551234567" --friend-name "Alice" --guardian-name "Bob" --contact-name "Alice Smith"`,
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
                contactName: opts.contactName,
                expectedExternalUserId: opts.expectedExternalUserId,
                friendName: opts.friendName,
                guardianName: opts.guardianName,
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
              if (invite.token)
                process.stdout.write(`Token: ${invite.token}\n`);
            }
          },
        );

      invites
        .command("revoke <inviteId>")
        .description("Revoke an active invite")
        .addHelpText(
          "after",
          `
Arguments:
  inviteId   UUID of the invite to revoke. Run 'assistant contacts invites list' to find IDs.

Revokes an active invite so it can no longer be redeemed. Already-redeemed
channel memberships are not affected. Returns the updated invite record.

Examples:
  $ assistant contacts invites revoke 7a3b1c2d-4e5f-6789-abcd-ef0123456789
  $ assistant contacts invites revoke abc-123 --json`,
        )
        .action(async (inviteId: string, _opts: unknown, cmd: Command) => {
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
        });

      invites
        .command("redeem")
        .description("Redeem an invite via token or voice code")
        .option("--token <token>", "Invite token")
        .option("--source-channel <channel>", "Channel for redemption")
        .option("--external-user-id <id>", "External user ID")
        .option("--external-chat-id <id>", "External chat ID")
        .option("--code <code>", "6-digit voice code")
        .option(
          "--caller-external-user-id <phone>",
          "E.164 phone number for voice code redemption",
        )
        .option(
          "--assistant-id <id>",
          "Assistant ID for voice code redemption",
        )
        .addHelpText(
          "after",
          `
Two redemption modes:

1. Token-based redemption: Provide --token, --source-channel, and at
   least one of --external-user-id or --external-chat-id. Creates a
   channel membership linking the contact to the external identifier.

2. Voice-code-based redemption: Provide --code (6-digit code) and
   --caller-external-user-id (E.164 phone number). Optionally include
   --assistant-id to scope the redemption to a specific assistant.

Examples:
  $ assistant contacts invites redeem --token xyz-789 --source-channel telegram --external-user-id 12345
  $ assistant contacts invites redeem --code 123456 --caller-external-user-id "+15551234567"
  $ assistant contacts invites redeem --code 654321 --caller-external-user-id "+15559876543" --assistant-id asst-abc --json`,
        )
        .action(
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
