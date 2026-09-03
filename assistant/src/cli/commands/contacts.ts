import type { Command } from "commander";

import type { ChannelId } from "../../channels/types.js";
import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { canonicalizeInboundIdentity } from "../../util/canonicalize-identity.js";
import {
  GUARDIAN_FORM_DEFAULT_TIMEOUT_MS,
  GUARDIAN_FORM_MAX_TIMEOUT_MS,
  guardianFormCallBudgetMs,
} from "../../util/guardian-form-timeouts.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { shouldOutputJson, writeError, writeOutput } from "../output.js";
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
  // Nullable on the wire (`contactSchema`, and the gateway's ContactRead):
  // a contact with no notes reads as null, not as an absent field.
  notes?: string | null;
  principalId?: string;
  createdAt: string | number;
  updatedAt: string | number;
  interactionCount: number | null;
  autoApproveThreshold?: string | null;
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
  /** Whether the channel is attested, as the guardian's checkbox left it. */
  verified?: boolean;
  /**
   * Whether submitted notes reached storage. Absent when none were submitted.
   * False means the contact and its channel were written without them.
   */
  notesSaved?: boolean;
  /** The guardian dismissed the form. Nothing was written. */
  cancelled?: boolean;
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
  if (c.role) {
    lines.push(`Role:         ${c.role}`);
  }
  lines.push(`Type:         ${c.contactType}`);
  lines.push(`Access:       ${c.autoApproveThreshold ?? "inherit"}`);
  if (c.notes) {
    lines.push(`Notes:        ${c.notes}`);
  }
  if (c.principalId) {
    lines.push(`Principal:    ${c.principalId}`);
  }
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

/**
 * Parse `--timeout`, which bounds how long the form stays open. Returns null
 * (after reporting) when the value is out of range, so a bad number fails here
 * rather than as a schema rejection after the round trip.
 */
function parseFormTimeout(
  raw: string | undefined,
  cmd: Command,
): number | null {
  if (raw === undefined) {
    return GUARDIAN_FORM_DEFAULT_TIMEOUT_MS;
  }
  // The whole token has to be digits: parseInt takes a valid prefix, so
  // "1e3" would pass as 1 and "100.5" as 100, quietly giving a form a
  // fraction of the wait it was asked for.
  const parsed = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    writeError(
      cmd,
      `Invalid --timeout "${raw}": expected a positive whole number of milliseconds`,
    );
    process.exitCode = 1;
    return null;
  }
  if (parsed > GUARDIAN_FORM_MAX_TIMEOUT_MS) {
    writeError(
      cmd,
      `Invalid --timeout "${raw}": the longest a form stays open is ${GUARDIAN_FORM_MAX_TIMEOUT_MS}ms`,
    );
    process.exitCode = 1;
    return null;
  }
  return parsed;
}

interface ContactRecordPromptBody {
  operation: "create" | "update" | "delete" | "merge";
  /** The contact the write lands on. On a merge, the survivor. */
  contactId?: string;
  currentDisplayName?: string;
  currentNotes?: string;
  channels?: Array<{ type: string; address: string }>;
  /** The contact being merged away. Present only on a merge. */
  donorContactId?: string;
  donorDisplayName?: string;
  donorChannels?: Array<{ type: string; address: string }>;
  displayName?: string;
  notes?: string;
  notesProposed?: boolean;
  label?: string;
  description?: string;
}

/**
 * Read a contact before proposing a write against it, so a bad id fails here
 * rather than after the guardian has answered a form about the wrong person.
 * The read is the gateway-relayed one, so it reflects the source of truth.
 */
async function readContactForPrompt(
  id: string,
  cmd: Command,
  /**
   * Whether a contact the read cannot see should still reach the form. A
   * dual-write gap can leave a contact in the assistant mirror that this
   * gateway-backed read misses, and deleting one of those is supported, so a
   * delete carries on with a bare record rather than refusing an id the
   * guardian can see. An update cannot: it needs the stored values to know
   * what the guardian actually changed.
   */
  allowUnreadable = false,
): Promise<ContactWithChannels | null> {
  const r = await cliIpcCall<{ ok: boolean; contact: ContactWithChannels }>(
    "getContact",
    { pathParams: { id } },
  );
  if (r.ok) {
    return r.result!.contact;
  }
  if (allowUnreadable && r.statusCode === 404) {
    return {
      id,
      displayName: id,
      contactType: "human",
      createdAt: 0,
      updatedAt: 0,
      interactionCount: null,
      channels: [],
    };
  }

  const failure = r as { ok: false; error?: string; statusCode?: number };
  exitFromIpcResult(
    failure.statusCode === 404
      ? {
          ...failure,
          error: `Contact "${id}" not found. Run 'assistant contacts list' to find contact ids.`,
        }
      : failure,
    cmd,
  );
  return null;
}

/**
 * The guardian closed the form without answering it. Nothing was written and
 * nothing went wrong, so this reports a plain line rather than an error
 * envelope a caller would read as a failed write.
 *
 * Exit 130 is the conventional user-interrupt code, and the same one
 * `credentials request` uses for a declined prompt, so a caller can tell a
 * deliberate dismissal from a genuine failure without parsing output.
 */
function reportFormDismissal(cmd: Command): void {
  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: true, cancelled: true });
  } else {
    process.stdout.write("Cancelled: nothing was written\n");
  }
  process.exitCode = 130;
}

interface AddressPromptOptions {
  channel?: string;
  placeholder?: string;
  defaultValue?: string;
  role?: string;
  label?: string;
  description?: string;
  timeout?: string;
  verify?: boolean;
  contactId?: string;
  contactDisplayName?: string;
  displayName?: string;
  notes?: string;
}

/**
 * Park on the guardian's answer to an address form, then report the channel it
 * bound. The guardian edits the address before submitting, so the report comes
 * from the result rather than from what was proposed.
 */
async function runAddressPrompt(
  opts: AddressPromptOptions,
  cmd: Command,
): Promise<void> {
  const timeoutMs = parseFormTimeout(opts.timeout, cmd);
  if (timeoutMs === null) {
    return;
  }
  const r = await cliIpcCall<ContactPromptResult>(
    "contacts_prompt",
    {
      body: {
        channel: opts.channel,
        placeholder: opts.placeholder,
        defaultValue: opts.defaultValue,
        role: opts.role,
        label: opts.label,
        description: opts.description,
        verify: opts.verify === true,
        contactId: opts.contactId,
        contactDisplayName: opts.contactDisplayName,
        displayName: opts.displayName,
        notes: opts.notes,
        timeoutMs,
      },
    },
    { timeoutMs: guardianFormCallBudgetMs(timeoutMs) },
  );

  if (!r.ok) {
    return exitFromIpcResult(
      r as { ok: false; error?: string; statusCode?: number },
      cmd,
    );
  }

  if (r.result?.cancelled === true) {
    return reportFormDismissal(cmd);
  }

  if (!r.result?.ok) {
    writeError(cmd, r.result?.error ?? "Contact prompt failed");
    process.exitCode = 1;
    return;
  }

  const result = r.result;
  // A gateway that does not honor the target binds by address instead, which
  // is the duplicate this command exists to avoid. It reports success, so the
  // mismatch is the only evidence.
  if (
    opts.contactId &&
    result.contactId &&
    result.contactId !== opts.contactId
  ) {
    writeError(
      cmd,
      `The channel was bound to contact ${result.contactId}, not the ${opts.contactId} this command named. The gateway is older than this CLI and cannot target a contact; upgrade it, then run 'assistant contacts merge ${opts.contactId} ${result.contactId}' to combine the two records.`,
    );
    process.exitCode = 1;
    return;
  }

  // Proposed notes the write said nothing about are neither saved nor known to
  // be lost, so the field carries null rather than an answer it does not have.
  const notesUnconfirmed =
    opts.notes !== undefined && result.notesSaved === undefined;

  if (shouldOutputJson(cmd)) {
    writeOutput(
      cmd,
      notesUnconfirmed ? { ...result, notesSaved: null } : result,
    );
    return;
  }

  process.stdout.write(
    `Registered ${result.channelType} channel: ${result.address}\n` +
      `  Channel ID: ${result.channelId}\n` +
      `  Contact ID: ${result.contactId}\n` +
      // The guardian's checkbox decides this, so report what the
      // channel is rather than what the flag asked for.
      `  Status:     ${result.verified ? "verified" : "unverified"}\n`,
  );

  // Notes are stored apart from the contact and the channel, so they can be
  // the one part that does not land. The bind stands either way, so this is a
  // partial outcome to report rather than a failed command. Proposed notes the
  // write says nothing about are the same outcome: a gateway that does not
  // report on them is one that did not carry them.
  if (result.notesSaved === false) {
    writeError(
      cmd,
      "The contact and channel were saved, but its notes were not",
    );
  } else if (notesUnconfirmed) {
    writeError(
      cmd,
      "The contact and channel were saved, but the write did not confirm its notes. Check them with 'assistant contacts get', and set them with 'assistant contacts update' if they are missing.",
    );
  }
}

/**
 * Say so when the address looks like somebody else's, without refusing.
 *
 * This search reads the assistant mirror rather than the gateway, so a contact
 * write whose mirror update failed can name a holder the gateway no longer has.
 * The gateway checks again against its own rows and refuses there, so warning
 * here surfaces the likely conflict without a stale read blocking a bind that
 * would succeed.
 */
async function warnIfAddressLooksTaken(
  channelType: string,
  address: string,
  targetContactId: string,
): Promise<void> {
  const r = await cliIpcCall<{ ok: boolean; contacts: ContactWithChannels[] }>(
    "listContacts",
    { queryParams: { channelAddress: address, channelType } },
  );
  if (!r.ok) {
    return;
  }

  // The search matches an address as a substring, so a returned contact may
  // hold a longer address that merely contains this one. Warning on that would
  // name a stranger and point at an irreversible merge. The comparison
  // canonicalizes the way the gateway's own check does, so a phone number
  // written differently still counts as the same address.
  const canonical = (value: string) =>
    canonicalizeInboundIdentity(channelType as ChannelId, value) ??
    value.trim().toLowerCase();
  const wanted = canonical(address);
  const holder = (r.result?.contacts ?? []).find(
    (c) =>
      c.id !== targetContactId &&
      c.channels.some(
        (ch) => ch.type === channelType && canonical(ch.address) === wanted,
      ),
  );
  if (!holder) {
    return;
  }

  process.stderr.write(
    `Warning: that ${channelType} address looks like it is already bound to "${holder.displayName}" (${holder.id}). ` +
      `Submitting the form will be refused if it still is. Run 'assistant contacts merge <keepId> <donorId>' if they are the same person.\n`,
  );
}

/**
 * Bind an address to a contact the caller named. The contact is read first, so
 * a bad id fails here rather than in front of the guardian, and the form names
 * it so they can see where the channel is going.
 */
async function runTargetedAddressPrompt(
  contactId: string,
  opts: AddressPromptOptions,
  cmd: Command,
): Promise<void> {
  const current = await readContactForPrompt(contactId, cmd);
  if (!current) {
    return;
  }
  if (opts.channel !== undefined && opts.defaultValue !== undefined) {
    await warnIfAddressLooksTaken(opts.channel, opts.defaultValue, contactId);
  }
  const defaultLabel = opts.channel
    ? `Add ${opts.channel} channel for ${current.displayName}`
    : undefined;
  await runAddressPrompt(
    {
      ...opts,
      contactId,
      contactDisplayName: current.displayName,
      // The target is fixed by the id, so the role hint has nothing to select.
      role: undefined,
      label: opts.label ?? defaultLabel,
    },
    cmd,
  );
}

/**
 * Park on the guardian's answer to a contact-record form, then report what was
 * actually written. The submitted values can differ from the proposed ones, so
 * the result is re-read rather than echoed back from the request.
 */
async function runRecordPrompt(
  body: ContactRecordPromptBody,
  timeout: string | undefined,
  cmd: Command,
): Promise<void> {
  const timeoutMs = parseFormTimeout(timeout, cmd);
  if (timeoutMs === null) {
    return;
  }
  const r = await cliIpcCall<{
    ok: boolean;
    error?: string;
    contactId?: string;
    notesSaved?: boolean;
    nothingWritten?: boolean;
    /**
     * Whether a merge's surviving contact took the submitted name. Absent
     * unless a rename was submitted. False means the merge committed and the
     * survivor kept its old name.
     */
    renamed?: boolean;
    /**
     * Whether a merge reached the assistant's own copy of the contacts. False
     * means the merge committed and the donor is still there, its notes on it
     * rather than combined onto the survivor.
     */
    mirrored?: boolean;
    cancelled?: boolean;
  }>(
    "contacts_record_prompt",
    { body: { ...body, timeoutMs } },
    { timeoutMs: guardianFormCallBudgetMs(timeoutMs) },
  );

  if (!r.ok) {
    return exitFromIpcResult(
      r as { ok: false; error?: string; statusCode?: number },
      cmd,
    );
  }

  if (r.result?.cancelled === true) {
    return reportFormDismissal(cmd);
  }

  if (!r.result?.ok) {
    writeError(cmd, r.result?.error ?? "Contact form failed");
    process.exitCode = 1;
    return;
  }

  const contactId = r.result.contactId;
  // Notes are stored apart from the rest of the record, so they can be the one
  // part that does not land. Whether that leaves nothing behind is the
  // gateway's to say: the guardian submits only the fields they changed, so
  // what this command proposed is no guide to what was written.
  const notesLost = r.result.notesSaved === false;
  const nothingWritten = r.result.nothingWritten === true;
  // A merge that could not apply the submitted name still merged, so this is a
  // partial outcome to report rather than a failed command.
  const renameLost = r.result.renamed === false;
  // Same shape: the merge committed, and only the assistant's own half of it
  // is outstanding.
  const mirrorLost = r.result.mirrored === false;

  if (body.operation === "delete") {
    const deleted = body.currentDisplayName ?? contactId ?? body.contactId;
    if (shouldOutputJson(cmd)) {
      writeOutput(cmd, { ok: true, deleted: true, contactId });
    } else {
      process.stdout.write(`Deleted contact: ${deleted} (${body.contactId})\n`);
    }
    return;
  }

  if (!contactId) {
    writeError(cmd, "Contact form returned no contact id");
    process.exitCode = 1;
    return;
  }

  // A merge names both contacts, so it leads with its own line instead of a
  // verb in front of "contact".
  const headline =
    body.operation === "merge"
      ? `Merged "${body.donorDisplayName}" into "${body.currentDisplayName}":`
      : `${body.operation === "create" ? "Created" : "Updated"} contact:`;

  // The write is already done and the guardian has already answered. This read
  // is only for what to print, so a failure here reports the write with less
  // detail rather than reporting the command as failed: an exit code that says
  // otherwise invites a retry, and retrying a create makes a second contact.
  const read = await cliIpcCall<{ ok: boolean; contact: ContactWithChannels }>(
    "getContact",
    { pathParams: { id: contactId } },
  );
  const written = read.ok ? read.result?.contact : undefined;

  if (nothingWritten) {
    // Nothing the caller asked for landed, so this is a failure however it is
    // read: one object, and a nonzero exit.
    if (shouldOutputJson(cmd)) {
      writeOutput(cmd, {
        ok: false,
        error: "The contact's notes could not be saved",
        contactId,
        notesSaved: false,
      });
    } else {
      writeError(cmd, "The contact's notes could not be saved");
    }
    process.exitCode = 1;
    return;
  }

  if (shouldOutputJson(cmd)) {
    // One object, whatever happened: a second one saying otherwise reads as a
    // failure to anything parsing this, and a retried create makes a duplicate.
    writeOutput(cmd, {
      ok: true,
      ...(written ? { contact: written } : { contactId }),
      ...(notesLost ? { notesSaved: false } : {}),
      ...(renameLost ? { renamed: false } : {}),
      ...(mirrorLost ? { mirrored: false } : {}),
    });
    return;
  }

  if (written) {
    process.stdout.write(`${headline}\n${formatContactDetail(written)}\n`);
  } else {
    process.stdout.write(`${headline} ${contactId}\n`);
    writeError(cmd, "Could not read the contact back to display it");
  }
  if (notesLost) {
    writeError(cmd, "The contact was saved, but its notes were not");
  }
  if (renameLost) {
    writeError(
      cmd,
      "The contacts were merged, but the surviving contact was not renamed",
    );
  }
  if (mirrorLost) {
    writeError(
      cmd,
      "The contacts were merged, but the assistant's copy of the duplicate was not cleaned up, so its notes were not combined",
    );
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

          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }

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

          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }

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
      // create / update / delete / merge
      //
      // Each opens a form in the guardian's app and blocks on their answer.
      // The daemon writes nothing: the guardian's client posts the confirmed
      // record straight to the gateway, so an unattended assistant cannot
      // change the contact graph.
      // -----------------------------------------------------------------------

      subcommand(contacts, "create").action(
        async (
          opts: {
            name?: string;
            notes?: string;
            channel?: string;
            address?: string;
            verify?: boolean;
            label?: string;
            description?: string;
            timeout?: string;
          },
          cmd: Command,
        ) => {
          if (opts.address !== undefined && !opts.channel) {
            writeError(
              cmd,
              "--address needs --channel: an address binds as a (channel type, address) pair. Pass --channel, or drop --address.",
            );
            process.exitCode = 1;
            return;
          }
          if (opts.verify && !opts.channel) {
            writeError(
              cmd,
              "--verify needs --channel: there is no channel to attest without one. Pass --channel, or drop --verify.",
            );
            process.exitCode = 1;
            return;
          }
          // A channel makes this the address form, which writes the record and
          // binds the channel under one confirmation.
          if (opts.channel) {
            if (!opts.name) {
              writeError(
                cmd,
                "--channel needs --name: the contact is created under that name. Pass --name, or run 'assistant contacts prompt' to create a contact named after the address.",
              );
              process.exitCode = 1;
              return;
            }
            await runAddressPrompt(
              {
                displayName: opts.name,
                notes: opts.notes,
                channel: opts.channel,
                defaultValue: opts.address,
                verify: opts.verify,
                label: opts.label,
                description: opts.description,
                timeout: opts.timeout,
              },
              cmd,
            );
            return;
          }
          await runRecordPrompt(
            {
              operation: "create",
              displayName: opts.name,
              notes: opts.notes,
              label: opts.label,
              description: opts.description,
            },
            opts.timeout,
            cmd,
          );
        },
      );

      subcommand(contacts, "update").action(
        async (
          id: string,
          opts: {
            name?: string;
            notes?: string;
            label?: string;
            description?: string;
            timeout?: string;
          },
          cmd: Command,
        ) => {
          if (!opts.name && opts.notes === undefined) {
            writeError(
              cmd,
              "At least one of --name or --notes must be provided",
            );
            process.exitCode = 1;
            return;
          }
          const current = await readContactForPrompt(id, cmd);
          if (!current) {
            return;
          }
          await runRecordPrompt(
            {
              operation: "update",
              contactId: id,
              currentDisplayName: current.displayName,
              // What is stored, so the form can tell an accepted proposal from
              // a field the guardian left alone.
              currentNotes: current.notes ?? undefined,
              displayName: opts.name,
              // Seed the form's notes field with what the contact already has,
              // so a name-only edit does not show an empty box the guardian
              // then submits over their notes. `??` keeps an explicit
              // `--notes ""` as the deliberate clear it is, and collapses the
              // null a notes-less contact reads as into an omitted field.
              notes: opts.notes ?? current.notes ?? undefined,
              // An explicit --notes is a change the guardian confirms, even
              // when it matches what is stored: comparison alone cannot tell
              // that from stored notes the read could not see.
              notesProposed: opts.notes !== undefined,
              label: opts.label,
              description: opts.description,
            },
            opts.timeout,
            cmd,
          );
        },
      );

      subcommand(contacts, "delete").action(
        async (
          id: string,
          opts: { label?: string; description?: string; timeout?: string },
          cmd: Command,
        ) => {
          const current = await readContactForPrompt(id, cmd, true);
          if (!current) {
            return;
          }
          await runRecordPrompt(
            {
              operation: "delete",
              contactId: id,
              currentDisplayName: current.displayName,
              // Two contacts can share a name, and deleting one takes its
              // channels with it. The confirmation has to say which contact
              // this is and what access is about to be lost.
              channels: current.channels.map((ch) => ({
                type: ch.type,
                address: ch.address,
              })),
              label: opts.label,
              description: opts.description,
            },
            opts.timeout,
            cmd,
          );
        },
      );

      subcommand(contacts, "merge").action(
        async (
          survivorId: string,
          donorId: string,
          opts: {
            keepDonorName?: boolean;
            label?: string;
            description?: string;
            timeout?: string;
          },
          cmd: Command,
        ) => {
          if (survivorId === donorId) {
            writeError(
              cmd,
              `Cannot merge contact "${survivorId}" into itself. Pass the surviving id and a different donor id. Run 'assistant contacts list' to find contact ids.`,
            );
            process.exitCode = 1;
            return;
          }
          const survivor = await readContactForPrompt(survivorId, cmd);
          if (!survivor) {
            return;
          }
          const donor = await readContactForPrompt(donorId, cmd);
          if (!donor) {
            return;
          }
          if (donor.role === "guardian") {
            // The gateway refuses this, so opening the form would spend a
            // confirmation on a write that cannot land.
            writeError(
              cmd,
              `Cannot merge away the guardian contact "${donor.displayName}" (${donorId}). Run 'assistant contacts merge ${donorId} ${survivorId}' to keep the guardian as the survivor instead.`,
            );
            process.exitCode = 1;
            return;
          }
          await runRecordPrompt(
            {
              operation: "merge",
              contactId: survivorId,
              currentDisplayName: survivor.displayName,
              donorContactId: donorId,
              donorDisplayName: donor.displayName,
              // Two contacts can share a name, so the confirmation lists both
              // sides: what moves, and what the survivor already holds.
              donorChannels: donor.channels.map((ch) => ({
                type: ch.type,
                address: ch.address,
              })),
              channels: survivor.channels.map((ch) => ({
                type: ch.type,
                address: ch.address,
              })),
              displayName: opts.keepDonorName ? donor.displayName : undefined,
              label: opts.label,
              description: opts.description,
            },
            opts.timeout,
            cmd,
          );
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
            defaultValue?: string;
            role?: string;
            label?: string;
            description?: string;
            timeout?: string;
            verify?: boolean;
            contactId?: string;
          },
          cmd: Command,
        ) => {
          if (opts.contactId && opts.role === "guardian") {
            writeError(
              cmd,
              "--contact-id and --role guardian cannot be combined: --role guardian binds to the guardian contact, so there is no target to choose. Drop --contact-id, or drop --role.",
            );
            process.exitCode = 1;
            return;
          }

          if (opts.contactId) {
            await runTargetedAddressPrompt(opts.contactId, opts, cmd);
            return;
          }

          // The form seeds a role either way, so an unstated one is stated
          // here rather than left for the daemon to pick.
          await runAddressPrompt(
            { ...opts, role: opts.role ?? "unknown" },
            cmd,
          );
        },
      );

      // -----------------------------------------------------------------------
      // channels
      // -----------------------------------------------------------------------

      const channelsCmds = subcommand(contacts, "channels");

      subcommand(channelsCmds, "add").action(
        async (
          contactId: string,
          opts: {
            channel: string;
            address?: string;
            verify?: boolean;
            label?: string;
            description?: string;
            timeout?: string;
          },
          cmd: Command,
        ) => {
          await runTargetedAddressPrompt(
            contactId,
            {
              channel: opts.channel,
              defaultValue: opts.address,
              verify: opts.verify,
              label: opts.label,
              description: opts.description,
              timeout: opts.timeout,
            },
            cmd,
          );
        },
      );

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

          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }

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

          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }

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

          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }

          const { invite } = r.result!;
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, invite });
          } else {
            process.stdout.write(
              `Created invite ${invite.id} (${invite.sourceChannel})\n`,
            );
            if (invite.token) {
              process.stdout.write(`Token: ${invite.token}\n`);
            }
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

          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }

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

          if (!r.ok) {
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          }

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
