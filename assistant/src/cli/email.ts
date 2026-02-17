/**
 * CLI command group: `vellum email`
 *
 * Provider-agnostic email operations routed through the service facade.
 * All commands output JSON to stdout. Use --json for machine-readable output.
 * Exit codes: 0 = success, 1 = error, 2 = guardrail blocked.
 */

import { Command } from 'commander';
import { getEmailService, GuardrailError } from '../email/service.js';
import { SUPPORTED_PROVIDERS, type SupportedProvider } from '../email/providers/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(data: unknown, json: boolean): void {
  process.stdout.write(
    json ? JSON.stringify(data) + '\n' : JSON.stringify(data, null, 2) + '\n',
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
    output({ ok: true, ...result as Record<string, unknown> }, getJson(cmd));
  } catch (err) {
    if (err instanceof GuardrailError) {
      outputError({ ok: false, error: err.code, ...err.details }, 2);
      return;
    }
    outputError({ ok: false, error: err instanceof Error ? err.message : String(err) }, 1);
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerEmailCommand(program: Command): void {
  const email = program
    .command('email')
    .description('Email operations (provider-agnostic)')
    .option('--json', 'Machine-readable JSON output');

  const svc = getEmailService();

  // =========================================================================
  // Provider subcommands
  // =========================================================================
  const provider = email.command('provider').description('Manage email provider');

  provider
    .command('get')
    .description('Show the active email provider')
    .action((_opts: unknown, cmd: Command) => {
      output({ ok: true, provider: svc.getProviderName() }, getJson(cmd));
    });

  provider
    .command('set <provider>')
    .description(`Set the active email provider (${SUPPORTED_PROVIDERS.join(', ')})`)
    .action((name: string, _opts: unknown, cmd: Command) => {
      if (!SUPPORTED_PROVIDERS.includes(name as SupportedProvider)) {
        exitError(`Unknown provider: ${name}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`);
        return;
      }
      svc.setProvider(name as SupportedProvider);
      output({ ok: true, provider: name }, getJson(cmd));
    });

  // =========================================================================
  // Status
  // =========================================================================
  email
    .command('status')
    .description('Show provider health, inboxes, and guardrail state')
    .action(async (_opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const status = await svc.status();
        return status;
      });
    });

  // =========================================================================
  // Setup subcommands
  // =========================================================================
  const setup = email.command('setup').description('Domain, inbox, and webhook setup');

  setup
    .command('domain')
    .description('Create/register a domain')
    .requiredOption('--domain <domain>', 'Domain name')
    .option('--dry-run', 'Preview without creating')
    .action(async (opts: { domain: string; dryRun?: boolean }, cmd: Command) => {
      await run(cmd, async () => {
        const domain = await svc.setupDomain(opts.domain, opts.dryRun);
        return { domain };
      });
    });

  setup
    .command('dns')
    .description('Get DNS records (SPF/DKIM/DMARC) for a domain')
    .requiredOption('--domain <domain>', 'Domain name')
    .action(async (opts: { domain: string }, cmd: Command) => {
      await run(cmd, async () => {
        const records = await svc.getDomainDnsRecords(opts.domain);
        return { domain: opts.domain, records };
      });
    });

  setup
    .command('verify')
    .description('Verify domain after DNS is configured')
    .requiredOption('--domain <domain>', 'Domain name')
    .action(async (opts: { domain: string }, cmd: Command) => {
      await run(cmd, async () => {
        const domain = await svc.verifyDomain(opts.domain);
        return { domain };
      });
    });

  setup
    .command('inboxes')
    .description('Create standard inboxes (hello@, support@, ops@)')
    .requiredOption('--domain <domain>', 'Domain name')
    .action(async (opts: { domain: string }, cmd: Command) => {
      await run(cmd, async () => {
        const inboxes = await svc.ensureInboxes(opts.domain);
        return { domain: opts.domain, inboxes };
      });
    });

  setup
    .command('webhook')
    .description('Register inbound webhook')
    .requiredOption('--url <url>', 'Webhook URL')
    .option('--secret <secret>', 'Webhook signing secret')
    .action(async (opts: { url: string; secret?: string }, cmd: Command) => {
      await run(cmd, async () => {
        const webhook = await svc.setupWebhook(opts.url, opts.secret);
        return { webhook };
      });
    });

  // =========================================================================
  // Draft subcommands
  // =========================================================================
  const draft = email.command('draft').description('Manage email drafts');

  draft
    .command('create')
    .description('Create a new draft')
    .requiredOption('--from <address>', 'Sender address or inbox ID')
    .requiredOption('--to <address>', 'Recipient email address')
    .requiredOption('--subject <subject>', 'Email subject')
    .requiredOption('--body <body>', 'Email body (plain text)')
    .option('--cc <address>', 'CC address')
    .option('--in-reply-to <messageId>', 'Message ID to reply to')
    .action(async (opts: {
      from: string;
      to: string;
      subject: string;
      body: string;
      cc?: string;
      inReplyTo?: string;
    }, cmd: Command) => {
      await run(cmd, async () => {
        const d = await svc.createDraft(opts);
        return { draft: d };
      });
    });

  draft
    .command('list')
    .description('List drafts')
    .option('--status <status>', 'Filter by status (pending|approved|sent|rejected)')
    .action(async (opts: { status?: string }, cmd: Command) => {
      await run(cmd, async () => {
        const drafts = await svc.listDrafts(opts.status);
        return { drafts };
      });
    });

  draft
    .command('get <draftId>')
    .description('Get a draft by ID')
    .action(async (draftId: string, _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const d = await svc.getDraft(draftId);
        return { draft: d };
      });
    });

  draft
    .command('approve-send')
    .alias('send')
    .alias('approve')
    .description('Check guardrails and send a draft')
    .requiredOption('--draft-id <id>', 'Draft ID to send')
    .option('--inbox <id>', 'Inbox ID (for multi-inbox setups)')
    .requiredOption('--confirm', 'Explicit confirmation flag (required)')
    .action(async (opts: { draftId: string; inbox?: string; confirm: boolean }, cmd: Command) => {
      if (!opts.confirm) {
        exitError('The --confirm flag is required for approve-send');
        return;
      }
      await run(cmd, async () => {
        const result = await svc.approveSend(opts.draftId, opts.inbox);
        return { messageId: result.messageId, threadId: result.threadId, dailyCount: result.dailyCount };
      });
    });

  draft
    .command('reject')
    .description('Reject a draft')
    .requiredOption('--draft-id <id>', 'Draft ID to reject')
    .option('--inbox <id>', 'Inbox ID (for multi-inbox setups)')
    .option('--reason <text>', 'Reason for rejection')
    .action(async (opts: { draftId: string; inbox?: string; reason?: string }, cmd: Command) => {
      await run(cmd, async () => {
        await svc.rejectDraft(opts.draftId, opts.reason, opts.inbox);
        return { draftId: opts.draftId, action: 'rejected' };
      });
    });

  draft
    .command('delete <draftId>')
    .description('Delete a draft')
    .option('--inbox <id>', 'Inbox ID (for multi-inbox setups)')
    .action(async (draftId: string, opts: { inbox?: string }, cmd: Command) => {
      await run(cmd, async () => {
        await svc.deleteDraft(draftId, opts.inbox);
        return { draftId, action: 'deleted' };
      });
    });

  // =========================================================================
  // Inbound subcommands
  // =========================================================================
  const inbound = email.command('inbound').alias('inbox').description('View inbound messages');

  inbound
    .command('list')
    .description('List inbound messages')
    .option('--thread-id <id>', 'Filter by thread ID')
    .action(async (opts: { threadId?: string }, cmd: Command) => {
      await run(cmd, async () => {
        const messages = await svc.listMessages(opts.threadId);
        return { messages };
      });
    });

  inbound
    .command('get <messageId>')
    .description('Get a specific inbound message')
    .action(async (messageId: string, _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const message = await svc.getMessage(messageId);
        return { message };
      });
    });

  // =========================================================================
  // Thread subcommands
  // =========================================================================
  const thread = email.command('thread').description('View email threads');

  thread
    .command('list')
    .description('List threads')
    .action(async (_opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const threads = await svc.listThreads();
        return { threads };
      });
    });

  thread
    .command('get <threadId>')
    .description('Get a specific thread')
    .action(async (threadId: string, _opts: unknown, cmd: Command) => {
      await run(cmd, async () => {
        const t = await svc.getThread(threadId);
        return { thread: t };
      });
    });

  // =========================================================================
  // Guardrails subcommands
  // =========================================================================
  const guardrails = email.command('guardrails').description('Manage email guardrails');

  guardrails
    .command('get')
    .description('Show current guardrail settings')
    .action((_opts: unknown, cmd: Command) => {
      output({ ok: true, ...svc.getGuardrails() }, getJson(cmd));
    });

  guardrails
    .command('set')
    .description('Update guardrail settings')
    .option('--paused <value>', 'Pause outbound (true/false)')
    .option('--daily-cap <n>', 'Daily send cap')
    .action((opts: { paused?: string; dailyCap?: string }, cmd: Command) => {
      const updates: { paused?: boolean; dailyCap?: number } = {};
      if (opts.paused !== undefined) {
        updates.paused = opts.paused === 'true';
      }
      if (opts.dailyCap !== undefined) {
        const n = parseInt(opts.dailyCap, 10);
        if (isNaN(n) || n < 0) {
          exitError('daily-cap must be a non-negative integer');
          return;
        }
        updates.dailyCap = n;
      }
      const result = svc.setGuardrails(updates);
      output({ ok: true, ...result }, getJson(cmd));
    });

  guardrails
    .command('block <pattern>')
    .description('Block addresses matching pattern (e.g., *@spam.com)')
    .action((pattern: string, _opts: unknown, cmd: Command) => {
      const rule = svc.addRule('block', pattern);
      output({ ok: true, rule }, getJson(cmd));
    });

  guardrails
    .command('allow <pattern>')
    .description('Allow addresses matching pattern')
    .action((pattern: string, _opts: unknown, cmd: Command) => {
      const rule = svc.addRule('allow', pattern);
      output({ ok: true, rule }, getJson(cmd));
    });

  guardrails
    .command('rules')
    .description('List all address rules')
    .action((_opts: unknown, cmd: Command) => {
      output({ ok: true, rules: svc.listAddressRules() }, getJson(cmd));
    });

  guardrails
    .command('unrule <ruleId>')
    .description('Remove an address rule by ID')
    .action((ruleId: string, _opts: unknown, cmd: Command) => {
      if (svc.removeRule(ruleId)) {
        output({ ok: true, ruleId, action: 'removed' }, getJson(cmd));
      } else {
        exitError(`No rule found matching "${ruleId}"`);
      }
    });
}
