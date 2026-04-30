import type { Command } from "commander";

import {
  getAssistantContactMetadata,
  getChannelById,
  getContact,
  listContacts,
  mergeContacts,
  searchContacts,
  updateChannelStatus,
  upsertContact,
} from "../../contacts/contact-store.js";
import type {
  AssistantContactMetadata,
  ChannelPolicy,
  ChannelStatus,
  ContactChannel,
  ContactRole,
  ContactType,
  ContactWithChannels,
} from "../../contacts/types.js";
import { getDb } from "../../memory/db-connection.js";
import {
  createIngressInvite,
  listIngressInvites,
  redeemIngressInvite,
  redeemVoiceInviteCode,
  revokeIngressInvite,
} from "../../runtime/invite-service.js";
import { shouldOutputJson, writeOutput } from "../output.js";

// ---------------------------------------------------------------------------
// Human-readable formatters
// ---------------------------------------------------------------------------

function formatChannelSummary(ch: ContactChannel): string {
  const parts = [ch.type, ch.address];
  if (ch.status !== "active") parts.push(`(${ch.status})`);
  if (ch.policy !== "allow") parts.push(`[${ch.policy}]`);
  return parts.join(" ");
}

function formatContactRow(c: ContactWithChannels): string {
  const channels =
    c.channels.length > 0
      ? c.channels.map(formatChannelSummary).join(", ")
      : "(no channels)";
  return `${c.id}  ${c.displayName}  ${c.role}/${c.contactType}  ${channels}`;
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
    for (const ch of c.channels) {
      const flags = [
        ch.isPrimary ? "primary" : null,
        ch.status !== "active" ? ch.status : null,
        ch.policy !== "allow" ? ch.policy : null,
      ]
        .filter(Boolean)
        .join(", ");
      const suffix = flags ? `  (${flags})` : "";
      lines.push(`  ${ch.id}  ${ch.type}  ${ch.address}${suffix}`);
    }
  }
  if (assistantMeta?.metadata && "assistantId" in assistantMeta.metadata) {
    lines.push("");
    lines.push(
      `Assistant:    ${assistantMeta.species} ${assistantMeta.metadata.assistantId}`,
    );
  }
  return lines.join("\n");
}

function formatChannelDetail(ch: ContactChannel): string {
  const lines: string[] = [];
  lines.push(`ID:       ${ch.id}`);
  lines.push(`Contact:  ${ch.contactId}`);
  lines.push(`Type:     ${ch.type}`);
  lines.push(`Address:  ${ch.address}`);
  lines.push(`Status:   ${ch.status}`);
  lines.push(`Policy:   ${ch.policy}`);
  if (ch.isPrimary) lines.push(`Primary:  yes`);
  if (ch.revokedReason) lines.push(`Revoked:  ${ch.revokedReason}`);
  if (ch.blockedReason) lines.push(`Blocked:  ${ch.blockedReason}`);
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
  const contacts = program
    .command("contacts")
    .description("Manage and query the contact graph")
    .option("--json", "Machine-readable compact JSON output");

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
  $ assistant contacts upsert --display-name "Alice"
  $ assistant contacts merge keep-id merge-id
  $ assistant contacts invites list`,
  );

  contacts
    .command("list")
    .description("List contacts")
    .option("--role <role>", "Filter by role (contact, guardian, or omit for all)")
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
        try {
          getDb();
          const role = opts.role as ContactRole | undefined;
          const limit = opts.limit ? Number(opts.limit) : undefined;

          const effectiveLimit = limit ?? 50;

          const hasSearchParams =
            opts.query || opts.channelAddress || opts.channelType;
          const results = hasSearchParams
            ? searchContacts({
                query: opts.query,
                channelAddress: opts.channelAddress,
                channelType: opts.channelType,
                role,
                limit: effectiveLimit,
              })
            : listContacts(effectiveLimit, role);

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, contacts: results });
          } else if (results.length === 0) {
            process.stdout.write("No contacts found.\n");
          } else {
            for (const c of results) {
              process.stdout.write(formatContactRow(c) + "\n");
            }
            process.stdout.write(`\n${results.length} contact(s)\n`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(cmd, message);
          process.exitCode = 1;
        }
      },
    );

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
      try {
        getDb();
        const contact = getContact(id);
        if (!contact) {
          writeError(cmd, "Contact not found");
          process.exitCode = 1;
          return;
        }
        const assistantMeta =
          contact.contactType === "assistant"
            ? getAssistantContactMetadata(contact.id)
            : undefined;
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, {
            ok: true,
            contact,
            assistantMetadata: assistantMeta ?? undefined,
          });
        } else {
          process.stdout.write(
            formatContactDetail(contact, assistantMeta ?? undefined) + "\n",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeError(cmd, message);
        process.exitCode = 1;
      }
    });

  contacts
    .command("merge <keepId> <mergeId>")
    .description("Merge two contacts")
    .addHelpText(
      "after",
      `
Arguments:
  keepId    UUID of the surviving contact that will absorb the other.
            Run 'assistant contacts list' to find IDs.
  mergeId   UUID of the contact to be merged and deleted

All channel memberships, conversation history, and metadata from mergeId
are transferred to keepId. After the merge, mergeId is permanently deleted.
This operation is irreversible.

Examples:
  $ assistant contacts merge 7a3b1c2d-4e5f-6789-abcd-ef0123456789 9f8e7d6c-5b4a-3210-fedc-ba9876543210
  $ assistant contacts merge keep-id merge-id --json`,
    )
    .action(
      async (keepId: string, mergeId: string, _opts: unknown, cmd: Command) => {
        try {
          getDb();
          const contact = mergeContacts(keepId, mergeId);
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, contact });
          } else {
            process.stdout.write(
              `Merged ${mergeId} into ${keepId}\n` +
                formatContactDetail(contact) +
                "\n",
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(cmd, message);
          process.exitCode = 1;
        }
      },
    );

  contacts
    .command("upsert")
    .description("Create or update a contact")
    .requiredOption("--display-name <name>", "Display name for the contact")
    .option("--id <id>", "Contact ID — provide to update an existing contact")
    .option("--notes <notes>", "Free-text notes about the contact")
    .option(
      "--role <role>",
      "Contact role: contact or guardian (default: contact for new contacts)",
    )
    .option(
      "--contact-type <type>",
      "Contact type: human or assistant (default: human for new contacts)",
    )
    .option(
      "--channels <json>",
      "JSON array of channel objects, each with type, address, and optional isPrimary, externalUserId, externalChatId, status, policy",
    )
    .addHelpText(
      "after",
      `
Creates a new contact or updates an existing one. When --id is provided and
matches an existing contact, that contact is updated. When --id is omitted,
a new contact is created with a generated UUID.

The --channels flag accepts a JSON array of channel objects. Each object must
have "type" (e.g. telegram, phone, email, whatsapp) and "address" fields.
Optional channel fields: isPrimary (boolean), externalUserId, externalChatId,
status (active, revoked, blocked), policy (allow, deny).

Examples:
  $ assistant contacts upsert --display-name "Alice" --json
  $ assistant contacts upsert --display-name "Alice" --id abc-123 --notes "Updated notes" --json
  $ assistant contacts upsert --display-name "Bob" --role guardian --json
  $ assistant contacts upsert --display-name "Bob" --channels '[{"type":"telegram","address":"12345","externalUserId":"12345","status":"active","policy":"allow"}]' --json`,
    )
    .action(
      async (
        opts: {
          displayName: string;
          id?: string;
          notes?: string;
          role?: string;
          contactType?: string;
          channels?: string;
        },
        cmd: Command,
      ) => {
        try {
          getDb();

          let channels: unknown[] | undefined;
          if (opts.channels) {
            try {
              channels = JSON.parse(opts.channels);
              if (!Array.isArray(channels)) {
                writeError(cmd, "--channels must be a JSON array");
                process.exitCode = 1;
                return;
              }
            } catch {
              writeError(
                cmd,
                `Invalid JSON for --channels: ${opts.channels}`,
              );
              process.exitCode = 1;
              return;
            }
          }

          const result = upsertContact({
            id: opts.id,
            displayName: opts.displayName,
            notes: opts.notes,
            role: opts.role as ContactRole | undefined,
            contactType: opts.contactType as ContactType | undefined,
            channels: channels as
              | {
                  type: string;
                  address: string;
                  isPrimary?: boolean;
                  externalUserId?: string;
                  externalChatId?: string;
                  status?: ChannelStatus;
                  policy?: ChannelPolicy;
                }[]
              | undefined,
          });

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, contact: result });
          } else {
            process.stdout.write(formatContactDetail(result) + "\n");
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(cmd, message);
          process.exitCode = 1;
        }
      },
    );

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
    .option("--policy <policy>", "New channel policy: allow, deny, or escalate")
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
        try {
          if (!opts.status && !opts.policy) {
            writeError(
              cmd,
              "At least one of --status or --policy must be provided",
            );
            process.exitCode = 1;
            return;
          }

          getDb();

          const existing = getChannelById(channelId);
          if (!existing) {
            writeError(cmd, `Channel not found: ${channelId}`);
            process.exitCode = 1;
            return;
          }

          const status = opts.status as ChannelStatus | undefined;
          const policy = opts.policy as ChannelPolicy | undefined;

          const revokedReason: string | null | undefined =
            status !== undefined
              ? status === "revoked"
                ? (opts.reason ?? null)
                : null
              : undefined;
          const blockedReason: string | null | undefined =
            status !== undefined
              ? status === "blocked"
                ? (opts.reason ?? null)
                : null
              : undefined;

          const result = updateChannelStatus(channelId, {
            status,
            policy,
            revokedReason,
            blockedReason,
          });

          if (!result) {
            writeError(cmd, `Failed to update channel: ${channelId}`);
            process.exitCode = 1;
            return;
          }

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, channel: result });
          } else {
            process.stdout.write(formatChannelDetail(result) + "\n");
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(cmd, message);
          process.exitCode = 1;
        }
      },
    );

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
        try {
          getDb();
          const result = listIngressInvites({
            sourceChannel: opts.sourceChannel,
            status: opts.status,
          });
          if (!result.ok) {
            writeError(cmd, (result as { error?: string }).error ?? "Failed");
            process.exitCode = 1;
            return;
          }
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, invites: result.data });
          } else if (result.data.length === 0) {
            process.stdout.write("No invites found.\n");
          } else {
              for (const inv of result.data) {
                const parts = [
                  inv.id,
                  inv.sourceChannel,
                  inv.status,
                  inv.token ? `token:${inv.token}` : "",
                ].filter(Boolean);
                process.stdout.write(parts.join("  ") + "\n");
              }
              process.stdout.write(`\n${result.data.length} invite(s)\n`);
            }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(cmd, message);
          process.exitCode = 1;
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
    .option("--friend-name <name>", "Friend name (required for voice invites)")
    .option(
      "--guardian-name <name>",
      "Guardian name (required for voice invites)",
    )
    .requiredOption("--contact-id <id>", "Contact ID to bind the invite to")
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
        try {
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
          getDb();
          const result = await createIngressInvite({
            sourceChannel: opts.sourceChannel,
            note: opts.note,
            maxUses,
            expiresInMs,
            contactName: opts.contactName,
            expectedExternalUserId: opts.expectedExternalUserId,
            friendName: opts.friendName,
            guardianName: opts.guardianName,
            contactId: opts.contactId,
          });
          if (!result.ok) {
            writeError(
              cmd,
              (result as { error?: string }).error ?? "Failed",
            );
            process.exitCode = 1;
            return;
          }
          if (shouldOutputJson(cmd)) {
              writeOutput(cmd, { ok: true, invite: result.data });
            } else {
              process.stdout.write(
                `Created invite ${result.data.id} (${result.data.sourceChannel})\n`,
              );
              if (result.data.token)
                process.stdout.write(`Token: ${result.data.token}\n`);
            }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(cmd, message);
          process.exitCode = 1;
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
      try {
        getDb();
        const result = revokeIngressInvite(inviteId);
        if (!result.ok) {
          writeError(
            cmd,
            (result as { error?: string }).error ?? "Failed",
          );
          process.exitCode = 1;
          return;
        }
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, { ok: true, invite: result.data });
        } else {
          process.stdout.write(`Revoked invite ${inviteId}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeError(cmd, message);
        process.exitCode = 1;
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
    .option("--assistant-id <id>", "Assistant ID for voice code redemption")
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
        try {
          getDb();
          if (opts.code) {
            if (!opts.callerExternalUserId) {
              writeError(
                cmd,
                "--caller-external-user-id is required for voice code redemption",
              );
              process.exitCode = 1;
              return;
            }
            const result = redeemVoiceInviteCode({
              code: opts.code,
              callerExternalUserId: opts.callerExternalUserId,
              sourceChannel: "phone",
              ...(opts.assistantId ? { assistantId: opts.assistantId } : {}),
            });
            if (result.ok) {
              if (shouldOutputJson(cmd)) {
                writeOutput(cmd, {
                  ok: true,
                  type: result.type,
                  memberId: result.memberId,
                  ...(result.type === "redeemed"
                    ? { inviteId: result.inviteId }
                    : {}),
                });
              } else {
                process.stdout.write(
                  `Redeemed (${result.type}), member: ${result.memberId}\n`,
                );
              }
            } else {
              writeError(cmd, result.reason);
              process.exitCode = 1;
            }
          } else {
            const result = redeemIngressInvite({
              token: opts.token,
              sourceChannel: opts.sourceChannel,
              ...(opts.externalUserId
                ? { externalUserId: opts.externalUserId }
                : {}),
              ...(opts.externalChatId
                ? { externalChatId: opts.externalChatId }
                : {}),
            });
            if (!result.ok) {
              writeError(
                cmd,
                (result as { error?: string }).error ?? "Failed",
              );
              process.exitCode = 1;
              return;
            }
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, { ok: true, invite: result.data });
            } else {
              process.stdout.write("Invite redeemed.\n");
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(cmd, message);
          process.exitCode = 1;
        }
      },
    );
}
