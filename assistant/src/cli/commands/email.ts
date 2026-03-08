/**
 * CLI command group: `assistant email`
 *
 * Provider-agnostic email operations routed through the service facade.
 * All commands output JSON to stdout. Use --json for machine-readable output.
 * Exit codes: 0 = success, 1 = error, 2 = guardrail blocked.
 */

import { Command } from "commander";

import {
  SUPPORTED_PROVIDERS,
  type SupportedProvider,
} from "../../email/providers/index.js";
import { getEmailService, GuardrailError } from "../../email/service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(data: unknown, json: boolean): void {
  process.stdout.write(
    json ? JSON.stringify(data) + "\n" : JSON.stringify(data, null, 2) + "\n",
  );
}

function outputError(data: unknown, code: number): void {
  output(data, true);
  process.exitCode = code;
}

function exitError(message: string, code = 1): void {
  outputError({ ok: false, error: message }, code);
}

function getJson(cmd: Command): boolean {
  let c: Command | null = cmd;
  while (c) {
    if ((c.opts() as { json?: boolean }).json) return true;
    c = c.parent;
  }
  return false;
}

async function run(cmd: Command, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    output({ ok: true, ...(result as Record<string, unknown>) }, getJson(cmd));
  } catch (err) {
    if (err instanceof GuardrailError) {
      outputError({ ok: false, error: err.code, ...err.details }, 2);
      return;
    }
    outputError(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      1,
    );
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerEmailCommand(program: Command): void {
  const email = program
    .command("email")
    .description("Email operations (provider-agnostic)")
    .option("--json", "Machine-readable JSON output");

  email.addHelpText(
    "after",
    `
Email commands are provider-agnostic — the same CLI works regardless of
the configured email provider (e.g. agentmail, resend). Use "email provider"
to switch between providers.

Outbound emails follow a draft-based sending model:
  1. Create a draft with "email draft create"
  2. Approve and send with "email draft approve-send"
  3. Optionally reject with "email draft reject"

Guardrails (outbound pause, daily send cap, address allow/block rules) are
enforced at send time. If a guardrail blocks sending, exit code 2 is returned.

Exit codes: 0 = success, 1 = error, 2 = guardrail blocked.

Examples:
  $ assistant email status
  $ assistant email draft create --from hello@example.com --to user@test.com --subject "Hello" --body "Hi there"
  $ assistant email draft approve-send --draft-id d_abc123 --confirm
  $ assistant email guardrails set --daily-cap 50
  $ assistant email setup domain --domain example.com`,
  );

  const svc = getEmailService();

  // =========================================================================
  // Provider subcommands
  // =========================================================================
  const provider = email
    .command("provider")
    .description("Manage email provider");

  provider.addHelpText(
    "after",
    `
Switch between email providers without changing the rest of your email
configuration. The active provider determines which backend handles domain
setup, inbox creation, DNS records, and message delivery.

Examples:
  $ assistant email provider get
  $ assistant email provider set agentmail`,
  );

  provider
    .command("get")
    .description("Show the active email provider")
    .addHelpText(
      "after",
      `
Returns the name of the currently active email provider (e.g. agentmail,
resend). Use this to confirm which backend is handling email operations
before making changes.

Examples:
  $ assistant email provider get
  $ assistant email provider get --json`,
    )
    .action((_opts: unknown, cmd: Command) => {
      output({ ok: true, provider: svc.getProviderName() }, getJson(cmd));
    });

  provider
    .command("set <provider>")
    .description(
      `Set the active email provider (${SUPPORTED_PROVIDERS.join(", ")})`,
    )
    .addHelpText(
      "after",
      `
Arguments:
  provider   The email provider to activate. Supported values: ${SUPPORTED_PROVIDERS.join(", ")}

Persists the provider selection to config. All subsequent email commands
(setup, inbox, draft, guardrails) will route through the selected provider.

Examples:
  $ assistant email provider set agentmail`,
    )
    .action((name: string, _opts: unknown, cmd: Command) => {
      if (!SUPPORTED_PROVIDERS.includes(name as SupportedProvider)) {
        exitError(
          `Unknown provider: ${name}. Supported: ${SUPPORTED_PROVIDERS.join(", ")}`,
        );
        return;
      }
      svc.setProvider(name as SupportedProvider);
      output({ ok: true, provider: name }, getJson(cmd));
    });

  // =========================================================================
  // Status
  // =========================================================================
  email
    .command("status")
    .description("Show provider health, inboxes, and guardrail state")
    .addHelpText(
      "after",
      `
Returns a combined view of the email subsystem: active provider and its health
status, configured inboxes with their addresses, and current guardrail state
(paused flag, daily send cap, today's send count).

Use this to verify the email stack is fully configured before sending.

Examples:
  $ assistant email status
  $ assistant email status --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const status = await svc.status();
        return status;
      });
    });

  // =========================================================================
  // Setup subcommands
  // =========================================================================
  const setup = email
    .command("setup")
    .description("Domain, inbox, and webhook setup");

  setup.addHelpText(
    "after",
    `
The setup workflow configures the email stack in order:
  1. domain   — Register a sending domain with the provider
  2. dns      — Retrieve SPF, DKIM, and DMARC records to add to your DNS
  3. verify   — Check that DNS records have propagated and are valid
  4. inboxes  — Create standard inboxes (hello@, support@, ops@)
  5. webhook  — Register an inbound webhook for receiving email

Run each step in sequence. "verify" will fail until DNS records propagate.

Examples:
  $ assistant email setup domain --domain example.com
  $ assistant email setup dns --domain example.com
  $ assistant email setup verify --domain example.com`,
  );

  setup
    .command("domain")
    .description("Create/register a domain")
    .requiredOption("--domain <domain>", "Domain name")
    .option("--dry-run", "Preview without creating")
    .addHelpText(
      "after",
      `
Registers a sending domain with the active email provider. The domain must
be a valid, publicly resolvable domain you control.

Use --dry-run to preview the registration without creating it. This returns
the DNS records that would need to be configured without committing changes.

Examples:
  $ assistant email setup domain --domain example.com
  $ assistant email setup domain --domain example.com --dry-run`,
    )
    .action(
      async (opts: { domain: string; dryRun?: boolean }, cmd: Command) => {
        await run(cmd, async () => {
          const domain = await svc.setupDomain(opts.domain, opts.dryRun);
          return { domain };
        });
      },
    );

  setup
    .command("dns")
    .description("Get DNS records (SPF/DKIM/DMARC) for a domain")
    .requiredOption("--domain <domain>", "Domain name")
    .addHelpText(
      "after",
      `
Returns the SPF, DKIM, and DMARC DNS records that must be added to your
domain's DNS zone. These records authorize the email provider to send on
behalf of your domain and improve deliverability.

Add all returned records to your DNS provider before running "setup verify".

Examples:
  $ assistant email setup dns --domain example.com
  $ assistant email setup dns --domain example.com --json`,
    )
    .action(async (opts: { domain: string }, cmd: Command) => {
      await run(cmd, async () => {
        const records = await svc.getDomainDnsRecords(opts.domain);
        return { domain: opts.domain, records };
      });
    });

  setup
    .command("verify")
    .description("Verify domain after DNS is configured")
    .requiredOption("--domain <domain>", "Domain name")
    .addHelpText(
      "after",
      `
Checks that the required DNS records (SPF, DKIM, DMARC) have propagated and
are correctly configured. DNS propagation can take minutes to hours depending
on your DNS provider's TTL settings.

Run this after adding all records returned by "setup dns". If verification
fails, wait for propagation and retry.

Examples:
  $ assistant email setup verify --domain example.com`,
    )
    .action(async (opts: { domain: string }, cmd: Command) => {
      await run(cmd, async () => {
        const domain = await svc.verifyDomain(opts.domain);
        return { domain };
      });
    });

  setup
    .command("inboxes")
    .description("Create standard inboxes (hello@, support@, ops@)")
    .requiredOption("--domain <domain>", "Domain name")
    .addHelpText(
      "after",
      `
Creates the standard set of inboxes (hello@, support@, ops@) on the
specified domain. Idempotent — re-running skips already existing inboxes.

The domain must be registered and verified before creating inboxes.

Examples:
  $ assistant email setup inboxes --domain example.com`,
    )
    .action(async (opts: { domain: string }, cmd: Command) => {
      await run(cmd, async () => {
        const inboxes = await svc.ensureInboxes(opts.domain);
        return { domain: opts.domain, inboxes };
      });
    });

  setup
    .command("webhook")
    .description("Register inbound webhook")
    .requiredOption("--url <url>", "Webhook URL")
    .option("--secret <secret>", "Webhook signing secret")
    .addHelpText(
      "after",
      `
Registers a webhook URL with the email provider to receive inbound messages.
The provider will POST incoming emails to this URL as JSON payloads.

If --secret is provided, the provider signs each webhook payload with the
secret so you can verify authenticity. If omitted, the provider may generate
one automatically (provider-dependent).

Examples:
  $ assistant email setup webhook --url https://example.com/api/email/inbound
  $ assistant email setup webhook --url https://example.com/api/email/inbound --secret whsec_abc123`,
    )
    .action(async (opts: { url: string; secret?: string }, cmd: Command) => {
      await run(cmd, async () => {
        const webhook = await svc.setupWebhook(opts.url, opts.secret);
        return { webhook };
      });
    });

  // =========================================================================
  // Inbox subcommands
  // =========================================================================
  const inbox = email.command("inbox").description("Manage inboxes");

  inbox.addHelpText(
    "after",
    `
Inboxes are email addresses that can send and receive messages through the
configured provider. Each inbox has a username (local part), domain, and
optional display name.

Examples:
  $ assistant email inbox list
  $ assistant email inbox create --username sam --domain example.com --display-name "Samwise"`,
  );

  inbox
    .command("create")
    .description("Create a new inbox")
    .requiredOption("--username <username>", 'Local part (e.g. "sam")')
    .option(
      "--domain <domain>",
      'Domain (e.g. "agentmail.to"). Omit for provider default.',
    )
    .option("--display-name <name>", 'Display name (e.g. "Samwise")')
    .addHelpText(
      "after",
      `
Creates a new inbox with the given username (local part) on the specified
domain. If --domain is omitted, the provider's default domain is used.

The --display-name sets the friendly name shown in the "From" header
(e.g. "Samwise <sam@example.com>").

Examples:
  $ assistant email inbox create --username sam --domain example.com
  $ assistant email inbox create --username support --domain example.com --display-name "Support Team"
  $ assistant email inbox create --username hello`,
    )
    .action(
      async (
        opts: { username: string; domain?: string; displayName?: string },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const created = await svc.createInbox(
            opts.username,
            opts.domain,
            opts.displayName,
          );
          return { inbox: created };
        });
      },
    );

  inbox
    .command("list")
    .description("List all inboxes")
    .addHelpText(
      "after",
      `
Lists all inboxes configured on the active email provider. Each inbox
entry includes its address, display name, and inbox ID.

Use this to verify which inboxes are available before creating drafts or
configuring inbound webhooks.

Examples:
  $ assistant email inbox list
  $ assistant email inbox list --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const inboxes = await svc.listInboxes();
        return { inboxes };
      });
    });

  // =========================================================================
  // Draft subcommands
  // =========================================================================
  const draft = email.command("draft").description("Manage email drafts");

  draft.addHelpText(
    "after",
    `
Drafts follow a lifecycle: create -> approve-send or reject.

  1. "draft create" stages an outbound email without sending it
  2. "draft approve-send" runs guardrail checks and sends if allowed
  3. "draft reject" permanently deletes a draft (will not be sent)

Drafts can also be listed, inspected by ID, or deleted. Use "draft list
--status pending" to see drafts awaiting approval.

Examples:
  $ assistant email draft create --from hello@example.com --to user@test.com --subject "Hi" --body "Hello"
  $ assistant email draft list --status pending
  $ assistant email draft approve-send --draft-id d_abc123 --confirm`,
  );

  draft
    .command("create")
    .description("Create a new draft")
    .requiredOption("--from <address>", "Sender address or inbox ID")
    .requiredOption("--to <address>", "Recipient email address")
    .requiredOption("--subject <subject>", "Email subject")
    .requiredOption("--body <body>", "Email body (plain text)")
    .option("--cc <address>", "CC address")
    .option("--in-reply-to <messageId>", "Message ID to reply to")
    .addHelpText(
      "after",
      `
Creates an outbound email draft without sending it. The draft must be
explicitly approved via "draft approve-send" before it is delivered.

Required fields:
  --from         Sender address (must match a configured inbox) or inbox ID
  --to           Recipient email address
  --subject      Email subject line
  --body         Email body in plain text

Optional fields:
  --cc           CC recipient address
  --in-reply-to  Message ID of the email being replied to (for threading)

Examples:
  $ assistant email draft create --from hello@example.com --to user@test.com --subject "Hello" --body "Hi there"
  $ assistant email draft create --from hello@example.com --to user@test.com --subject "Re: Question" --body "Sure thing" --in-reply-to msg_abc123
  $ assistant email draft create --from hello@example.com --to user@test.com --subject "Update" --body "FYI" --cc manager@test.com`,
    )
    .action(
      async (
        opts: {
          from: string;
          to: string;
          subject: string;
          body: string;
          cc?: string;
          inReplyTo?: string;
        },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          const d = await svc.createDraft(opts);
          return { draft: d };
        });
      },
    );

  draft
    .command("list")
    .description("List drafts")
    .option(
      "--status <status>",
      "Filter by status (pending|approved|sent|rejected)",
    )
    .addHelpText(
      "after",
      `
Lists all email drafts, optionally filtered by status. Returns an array
of draft objects with their IDs, recipients, subjects, and current status.

Use --status to narrow results to a specific lifecycle stage:
  pending   — created but not yet approved
  approved  — approved and queued for sending
  sent      — successfully delivered
  rejected  — delivery failed by the provider (e.g. bounce or send error)

Note: drafts rejected via "draft reject" are permanently deleted and will
not appear here. The "rejected" status only applies to provider-side
delivery failures.

Examples:
  $ assistant email draft list
  $ assistant email draft list --status pending
  $ assistant email draft list --status sent --json`,
    )
    .action(async (opts: { status?: string }, cmd: Command) => {
      await run(cmd, async () => {
        const drafts = await svc.listDrafts(opts.status);
        return { drafts };
      });
    });

  draft
    .command("get <draftId>")
    .description("Get a draft by ID")
    .option("--inbox <id>", "Inbox ID (for multi-inbox setups)")
    .addHelpText(
      "after",
      `
Arguments:
  draftId   The ID of the draft to retrieve (e.g. d_abc123)

Returns the full draft object including sender, recipient, subject, body,
status, and timestamps. Use --inbox to scope the lookup in multi-inbox
setups.

Examples:
  $ assistant email draft get d_abc123
  $ assistant email draft get d_abc123 --inbox inbox_456
  $ assistant email draft get d_abc123 --json`,
    )
    .action(async (draftId: string, opts: { inbox?: string }, cmd: Command) => {
      await run(cmd, async () => {
        const d = await svc.getDraft(draftId, opts.inbox);
        return { draft: d };
      });
    });

  draft
    .command("approve-send")
    .alias("send")
    .alias("approve")
    .description("Check guardrails and send a draft")
    .requiredOption("--draft-id <id>", "Draft ID to send")
    .option("--inbox <id>", "Inbox ID (for multi-inbox setups)")
    .requiredOption("--confirm", "Explicit confirmation flag (required)")
    .addHelpText(
      "after",
      `
Runs guardrail checks (outbound pause, daily send cap, address block/allow
rules) and sends the draft if all checks pass. The --confirm flag is required
as an explicit safety gate.

If a guardrail blocks the send, the command exits with code 2 and returns
the guardrail error details in the response JSON. The draft remains in
pending state and can be retried after adjusting guardrails.

Aliases: "draft send", "draft approve"

Examples:
  $ assistant email draft approve-send --draft-id d_abc123 --confirm
  $ assistant email draft approve-send --draft-id d_abc123 --confirm --json`,
    )
    .action(
      async (
        opts: { draftId: string; inbox?: string; confirm: boolean },
        cmd: Command,
      ) => {
        if (!opts.confirm) {
          exitError("The --confirm flag is required for approve-send");
          return;
        }
        await run(cmd, async () => {
          const result = await svc.approveSend(opts.draftId, opts.inbox);
          return {
            messageId: result.messageId,
            threadId: result.threadId,
            dailyCount: result.dailyCount,
          };
        });
      },
    );

  draft
    .command("reject")
    .description("Reject a draft")
    .requiredOption("--draft-id <id>", "Draft ID to reject")
    .option("--inbox <id>", "Inbox ID (for multi-inbox setups)")
    .option("--reason <text>", "Reason for rejection")
    .addHelpText(
      "after",
      `
Rejects a pending draft by permanently deleting it so it will not be
sent. The --reason flag is accepted for logging but the draft itself is
removed from the provider and cannot be recovered.

Examples:
  $ assistant email draft reject --draft-id d_abc123
  $ assistant email draft reject --draft-id d_abc123 --reason "Wrong recipient"
  $ assistant email draft reject --draft-id d_abc123 --inbox inbox_456`,
    )
    .action(
      async (
        opts: { draftId: string; inbox?: string; reason?: string },
        cmd: Command,
      ) => {
        await run(cmd, async () => {
          await svc.rejectDraft(opts.draftId, opts.reason, opts.inbox);
          return { draftId: opts.draftId, action: "rejected" };
        });
      },
    );

  draft
    .command("delete <draftId>")
    .description("Delete a draft")
    .option("--inbox <id>", "Inbox ID (for multi-inbox setups)")
    .addHelpText(
      "after",
      `
Arguments:
  draftId   The ID of the draft to delete (e.g. d_abc123)

Permanently removes a draft from the system. Both "reject" and "delete"
result in permanent deletion; use "reject" when you want to log a reason
for not sending. Use --inbox to scope the deletion in multi-inbox setups.

Examples:
  $ assistant email draft delete d_abc123
  $ assistant email draft delete d_abc123 --inbox inbox_456`,
    )
    .action(async (draftId: string, opts: { inbox?: string }, cmd: Command) => {
      await run(cmd, async () => {
        await svc.deleteDraft(draftId, opts.inbox);
        return { draftId, action: "deleted" };
      });
    });

  // =========================================================================
  // Inbound subcommands
  // =========================================================================
  const inbound = email.command("inbound").description("View inbound messages");

  inbound.addHelpText(
    "after",
    `
View messages received by your inboxes. Inbound messages are emails sent
to your configured inbox addresses by external senders.

Use "inbound list" to browse received messages and "inbound get" to
retrieve the full content of a specific message.

Examples:
  $ assistant email inbound list
  $ assistant email inbound list --thread-id thr_abc123
  $ assistant email inbound get msg_def456`,
  );

  inbound
    .command("list")
    .description("List inbound messages")
    .option("--thread-id <id>", "Filter by thread ID")
    .option("--inbox <id>", "Inbox ID (for multi-inbox setups)")
    .addHelpText(
      "after",
      `
Lists inbound messages received by your inboxes. Optionally filter by
thread ID to see only messages belonging to a specific conversation, or
by inbox ID to scope to a particular inbox.

Examples:
  $ assistant email inbound list
  $ assistant email inbound list --thread-id thr_abc123
  $ assistant email inbound list --inbox inbox_456
  $ assistant email inbound list --json`,
    )
    .action(
      async (opts: { threadId?: string; inbox?: string }, cmd: Command) => {
        await run(cmd, async () => {
          const messages = await svc.listMessages(opts.threadId, opts.inbox);
          return { messages };
        });
      },
    );

  inbound
    .command("get <messageId>")
    .description("Get a specific inbound message")
    .addHelpText(
      "after",
      `
Arguments:
  messageId   The ID of the inbound message to retrieve (e.g. msg_abc123)

Returns the full inbound message including sender, recipients, subject,
body, headers, and timestamps.

Examples:
  $ assistant email inbound get msg_abc123
  $ assistant email inbound get msg_abc123 --json`,
    )
    .action(async (messageId: string, _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const message = await svc.getMessage(messageId);
        return { message };
      });
    });

  // =========================================================================
  // Thread subcommands
  // =========================================================================
  const thread = email.command("thread").description("View email threads");

  thread.addHelpText(
    "after",
    `
Threads group related emails (original message and replies) into a single
conversation. Each thread has a unique ID and contains one or more messages.

Use "thread list" to browse all threads and "thread get" to retrieve
the full conversation history for a specific thread.

Examples:
  $ assistant email thread list
  $ assistant email thread get thr_abc123`,
  );

  thread
    .command("list")
    .description("List threads")
    .addHelpText(
      "after",
      `
Lists all email threads. Each thread entry includes its ID, subject,
participant addresses, message count, and timestamps.

Examples:
  $ assistant email thread list
  $ assistant email thread list --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const threads = await svc.listThreads();
        return { threads };
      });
    });

  thread
    .command("get <threadId>")
    .description("Get a specific thread")
    .addHelpText(
      "after",
      `
Arguments:
  threadId   The ID of the thread to retrieve (e.g. thr_abc123)

Returns the full thread including all messages (inbound and outbound),
participants, subject, and timestamps. Messages are ordered chronologically.

Examples:
  $ assistant email thread get thr_abc123
  $ assistant email thread get thr_abc123 --json`,
    )
    .action(async (threadId: string, _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const t = await svc.getThread(threadId);
        return { thread: t };
      });
    });

  // =========================================================================
  // Guardrails subcommands
  // =========================================================================
  const guardrails = email
    .command("guardrails")
    .description("Manage email guardrails");

  guardrails.addHelpText(
    "after",
    `
Guardrails are safety controls enforced at send time (during "draft
approve-send"). Three types of guardrails exist:

  1. Outbound pause — when paused=true, all sends are blocked
  2. Daily send cap — limits the total number of emails sent per day
  3. Address rules  — block or allow patterns (e.g. *@spam.com)

When a guardrail blocks a send, exit code 2 is returned with the specific
guardrail error in the response.

Examples:
  $ assistant email guardrails get
  $ assistant email guardrails set --paused true
  $ assistant email guardrails set --daily-cap 100
  $ assistant email guardrails block "*@spam.com"`,
  );

  guardrails
    .command("get")
    .description("Show current guardrail settings")
    .addHelpText(
      "after",
      `
Returns the current guardrail configuration: outbound pause state,
daily send cap, today's send count, and a summary of address rules.

Use this to verify guardrail settings before sending emails.

Examples:
  $ assistant email guardrails get
  $ assistant email guardrails get --json`,
    )
    .action((_opts: unknown, cmd: Command) => {
      output({ ok: true, ...svc.getGuardrails() }, getJson(cmd));
    });

  guardrails
    .command("set")
    .description("Update guardrail settings")
    .option("--paused <value>", "Pause outbound (true/false)")
    .option("--daily-cap <n>", "Daily send cap")
    .addHelpText(
      "after",
      `
Updates one or both guardrail settings. Omitted flags leave the existing
value unchanged.

  --paused true/false   Enable or disable the outbound pause. When paused,
                        all "approve-send" calls are blocked with exit code 2.
  --daily-cap <n>       Set the maximum number of emails that can be sent per
                        calendar day. Set to 0 to disable sending entirely.

Examples:
  $ assistant email guardrails set --paused true
  $ assistant email guardrails set --paused false --daily-cap 50
  $ assistant email guardrails set --daily-cap 0`,
    )
    .action((opts: { paused?: string; dailyCap?: string }, cmd: Command) => {
      const updates: { paused?: boolean; dailyCap?: number } = {};
      if (opts.paused !== undefined) {
        updates.paused = opts.paused === "true";
      }
      if (opts.dailyCap !== undefined) {
        const n = parseInt(opts.dailyCap, 10);
        if (isNaN(n) || n < 0) {
          exitError("daily-cap must be a non-negative integer");
          return;
        }
        updates.dailyCap = n;
      }
      const result = svc.setGuardrails(updates);
      output({ ok: true, ...result }, getJson(cmd));
    });

  guardrails
    .command("block <pattern>")
    .description("Block addresses matching pattern (e.g., *@spam.com)")
    .addHelpText(
      "after",
      `
Arguments:
  pattern   Glob pattern matching email addresses to block. Supports * as
            wildcard. Examples: "*@spam.com", "user@*", "*@*.example.com"

Creates a block rule. Any "approve-send" to a recipient matching this
pattern will be rejected with exit code 2. Rules are evaluated in order;
block rules take precedence over allow rules for the same address.

Examples:
  $ assistant email guardrails block "*@spam.com"
  $ assistant email guardrails block "marketing@*"`,
    )
    .action((pattern: string, _opts: unknown, cmd: Command) => {
      const rule = svc.addRule("block", pattern);
      output({ ok: true, rule }, getJson(cmd));
    });

  guardrails
    .command("allow <pattern>")
    .description("Allow addresses matching pattern")
    .addHelpText(
      "after",
      `
Arguments:
  pattern   Glob pattern matching email addresses to allow. Supports * as
            wildcard. Examples: "*@partner.com", "vip@*", "*@*.trusted.com"

Creates an allow rule. Addresses matching this pattern will pass the
address-rule guardrail check during "approve-send". Note that block rules
take precedence over allow rules for the same address.

Examples:
  $ assistant email guardrails allow "*@partner.com"
  $ assistant email guardrails allow "vip@example.com"`,
    )
    .action((pattern: string, _opts: unknown, cmd: Command) => {
      const rule = svc.addRule("allow", pattern);
      output({ ok: true, rule }, getJson(cmd));
    });

  guardrails
    .command("rules")
    .description("List all address rules")
    .addHelpText(
      "after",
      `
Lists all configured address rules (both block and allow). Each rule
entry includes its ID, type (block or allow), and the glob pattern.

Use the rule ID with "guardrails unrule" to remove a specific rule.

Examples:
  $ assistant email guardrails rules
  $ assistant email guardrails rules --json`,
    )
    .action((_opts: unknown, cmd: Command) => {
      output({ ok: true, rules: svc.listAddressRules() }, getJson(cmd));
    });

  guardrails
    .command("unrule <ruleId>")
    .description("Remove an address rule by ID")
    .addHelpText(
      "after",
      `
Arguments:
  ruleId   The ID of the address rule to remove. Use "guardrails rules" to
           list all rules and their IDs.

Permanently removes a block or allow rule. The rule takes effect immediately —
subsequent "approve-send" calls will no longer be affected by the removed rule.

Examples:
  $ assistant email guardrails unrule rule_abc123
  $ assistant email guardrails rules   # list rules to find the ID first`,
    )
    .action((ruleId: string, _opts: unknown, cmd: Command) => {
      if (svc.removeRule(ruleId)) {
        output({ ok: true, ruleId, action: "removed" }, getJson(cmd));
      } else {
        exitError(`No rule found matching "${ruleId}"`);
      }
    });
}
