/**
 * CLI command: `vellum email`
 *
 * Provider-agnostic email operations implemented directly in @vellumai/cli.
 * All subcommand parsing, output formatting, and service logic lives here.
 *
 * All commands output JSON to stdout.
 * Exit codes: 0 = success, 1 = error, 2 = guardrail blocked.
 */

import {
  getEmailService,
  GuardrailError,
} from "../email/service.js";

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

async function run(json: boolean, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    output(
      { ok: true, ...(result as Record<string, unknown>) },
      json,
    );
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
// Arg parsing helpers
// ---------------------------------------------------------------------------

interface ParsedFlags {
  json: boolean;
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  let json = false;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--dry-run") {
      flags["dryRun"] = true;
    } else if (arg === "--confirm") {
      flags["confirm"] = true;
    } else if (arg.startsWith("--")) {
      const key = arg
        .slice(2)
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { json, flags, positional };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`Usage: vellum email <subcommand> [options]

Subcommands:
  status                        Show provider health and guardrail state

  setup domain --domain <d>     Create/register a domain
  setup dns --domain <d>        Get DNS records for a domain
  setup verify --domain <d>     Verify domain after DNS setup
  setup inboxes --domain <d>    Create standard inboxes
  setup webhook --url <u>       Register inbound webhook

  inbox create --username <u>   Create a new inbox
  inbox list                    List all inboxes

  draft create --from <a> --to <a> --subject <s> --body <b>
  draft list [--status <s>]     List drafts
  draft get <draftId>           Get a draft by ID
  draft approve-send --draft-id <id> --confirm
  draft reject --draft-id <id>  Reject a draft
  draft delete <draftId>        Delete a draft

  inbound list                  List inbound messages
  inbound get <messageId>       Get a specific inbound message

  thread list                   List email threads
  thread get <threadId>         Get a specific thread

  guardrails get                Show guardrail settings
  guardrails set                Update guardrails (--paused, --daily-cap)
  guardrails block <pattern>    Block addresses matching pattern
  guardrails allow <pattern>    Allow addresses matching pattern
  guardrails rules              List all address rules
  guardrails unrule <ruleId>    Remove an address rule

Options:
  --json                        Machine-readable JSON output
  --help, -h                    Show this help message
`);
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function handleStatus(json: boolean): Promise<void> {
  const svc = getEmailService();
  await run(json, async () => {
    const status = await svc.status();
    return status;
  });
}

async function handleSetup(
  subArgs: string[],
  json: boolean,
): Promise<void> {
  const svc = getEmailService();
  const sub = subArgs[0];
  const { flags } = parseFlags(subArgs.slice(1));

  switch (sub) {
    case "domain": {
      const domain = flags["domain"] as string;
      if (!domain) {
        exitError("--domain is required");
        return;
      }
      await run(json, async () => {
        const d = await svc.setupDomain(domain, !!flags["dryRun"]);
        return { domain: d };
      });
      break;
    }
    case "dns": {
      const domain = flags["domain"] as string;
      if (!domain) {
        exitError("--domain is required");
        return;
      }
      await run(json, async () => {
        const records = await svc.getDomainDnsRecords(domain);
        return { domain, records };
      });
      break;
    }
    case "verify": {
      const domain = flags["domain"] as string;
      if (!domain) {
        exitError("--domain is required");
        return;
      }
      await run(json, async () => {
        const d = await svc.verifyDomain(domain);
        return { domain: d };
      });
      break;
    }
    case "inboxes": {
      const domain = flags["domain"] as string;
      if (!domain) {
        exitError("--domain is required");
        return;
      }
      await run(json, async () => {
        const inboxes = await svc.ensureInboxes(domain);
        return { domain, inboxes };
      });
      break;
    }
    case "webhook": {
      const url = flags["url"] as string;
      if (!url) {
        exitError("--url is required");
        return;
      }
      await run(json, async () => {
        const webhook = await svc.setupWebhook(
          url,
          flags["secret"] as string | undefined,
        );
        return { webhook };
      });
      break;
    }
    default:
      exitError("Usage: vellum email setup <domain|dns|verify|inboxes|webhook>");
  }
}

async function handleInbox(
  subArgs: string[],
  json: boolean,
): Promise<void> {
  const svc = getEmailService();
  const sub = subArgs[0];
  const { flags } = parseFlags(subArgs.slice(1));

  if (sub === "create") {
    const username = flags["username"] as string;
    if (!username) {
      exitError("--username is required");
      return;
    }
    await run(json, async () => {
      const created = await svc.createInbox(
        username,
        flags["domain"] as string | undefined,
        flags["displayName"] as string | undefined,
      );
      return { inbox: created };
    });
  } else if (sub === "list") {
    await run(json, async () => {
      const inboxes = await svc.listInboxes();
      return { inboxes };
    });
  } else {
    exitError("Usage: vellum email inbox <create|list>");
  }
}

async function handleDraft(
  subArgs: string[],
  json: boolean,
): Promise<void> {
  const svc = getEmailService();
  const sub = subArgs[0];
  const { flags, positional } = parseFlags(subArgs.slice(1));

  switch (sub) {
    case "create": {
      const from = flags["from"] as string;
      const to = flags["to"] as string;
      const subject = flags["subject"] as string;
      const body = flags["body"] as string;
      if (!from || !to || !subject || !body) {
        exitError("--from, --to, --subject, and --body are required");
        return;
      }
      await run(json, async () => {
        const d = await svc.createDraft({
          from,
          to,
          subject,
          body,
          cc: flags["cc"] as string | undefined,
          inReplyTo: flags["inReplyTo"] as string | undefined,
        });
        return { draft: d };
      });
      break;
    }
    case "list":
      await run(json, async () => {
        const drafts = await svc.listDrafts(
          flags["status"] as string | undefined,
        );
        return { drafts };
      });
      break;
    case "get": {
      const draftId = positional[0];
      if (!draftId) {
        exitError("Draft ID is required");
        return;
      }
      await run(json, async () => {
        const d = await svc.getDraft(
          draftId,
          flags["inbox"] as string | undefined,
        );
        return { draft: d };
      });
      break;
    }
    case "approve-send":
    case "send":
    case "approve": {
      const draftId = flags["draftId"] as string;
      if (!draftId) {
        exitError("--draft-id is required");
        return;
      }
      if (!flags["confirm"]) {
        exitError("The --confirm flag is required for approve-send");
        return;
      }
      await run(json, async () => {
        const result = await svc.approveSend(
          draftId,
          flags["inbox"] as string | undefined,
        );
        return {
          messageId: result.messageId,
          threadId: result.threadId,
          dailyCount: result.dailyCount,
        };
      });
      break;
    }
    case "reject": {
      const draftId = flags["draftId"] as string;
      if (!draftId) {
        exitError("--draft-id is required");
        return;
      }
      await run(json, async () => {
        await svc.rejectDraft(
          draftId,
          flags["reason"] as string | undefined,
          flags["inbox"] as string | undefined,
        );
        return { draftId, action: "rejected" };
      });
      break;
    }
    case "delete": {
      const draftId = positional[0];
      if (!draftId) {
        exitError("Draft ID is required");
        return;
      }
      await run(json, async () => {
        await svc.deleteDraft(
          draftId,
          flags["inbox"] as string | undefined,
        );
        return { draftId, action: "deleted" };
      });
      break;
    }
    default:
      exitError(
        "Usage: vellum email draft <create|list|get|approve-send|reject|delete>",
      );
  }
}

async function handleInbound(
  subArgs: string[],
  json: boolean,
): Promise<void> {
  const svc = getEmailService();
  const sub = subArgs[0];
  const { flags, positional } = parseFlags(subArgs.slice(1));

  if (sub === "list") {
    await run(json, async () => {
      const messages = await svc.listMessages(
        flags["threadId"] as string | undefined,
        flags["inbox"] as string | undefined,
      );
      return { messages };
    });
  } else if (sub === "get") {
    const messageId = positional[0];
    if (!messageId) {
      exitError("Message ID is required");
      return;
    }
    await run(json, async () => {
      const message = await svc.getMessage(messageId);
      return { message };
    });
  } else {
    exitError("Usage: vellum email inbound <list|get>");
  }
}

async function handleThread(
  subArgs: string[],
  json: boolean,
): Promise<void> {
  const svc = getEmailService();
  const sub = subArgs[0];
  const { positional } = parseFlags(subArgs.slice(1));

  if (sub === "list") {
    await run(json, async () => {
      const threads = await svc.listThreads();
      return { threads };
    });
  } else if (sub === "get") {
    const threadId = positional[0];
    if (!threadId) {
      exitError("Thread ID is required");
      return;
    }
    await run(json, async () => {
      const t = await svc.getThread(threadId);
      return { thread: t };
    });
  } else {
    exitError("Usage: vellum email thread <list|get>");
  }
}

function handleGuardrails(
  subArgs: string[],
  json: boolean,
): void {
  const svc = getEmailService();
  const sub = subArgs[0];
  const { flags, positional } = parseFlags(subArgs.slice(1));

  switch (sub) {
    case "get":
      output({ ok: true, ...svc.getGuardrails() }, json);
      break;
    case "set": {
      const updates: { paused?: boolean; dailyCap?: number } = {};
      if (flags["paused"] !== undefined) {
        updates.paused = flags["paused"] === "true" || flags["paused"] === true;
      }
      if (flags["dailyCap"] !== undefined) {
        const n = parseInt(flags["dailyCap"] as string, 10);
        if (isNaN(n) || n < 0) {
          exitError("daily-cap must be a non-negative integer");
          return;
        }
        updates.dailyCap = n;
      }
      const result = svc.setGuardrails(updates);
      output({ ok: true, ...result }, json);
      break;
    }
    case "block": {
      const pattern = positional[0];
      if (!pattern) {
        exitError("Pattern is required");
        return;
      }
      const rule = svc.addRule("block", pattern);
      output({ ok: true, rule }, json);
      break;
    }
    case "allow": {
      const pattern = positional[0];
      if (!pattern) {
        exitError("Pattern is required");
        return;
      }
      const rule = svc.addRule("allow", pattern);
      output({ ok: true, rule }, json);
      break;
    }
    case "rules":
      output({ ok: true, rules: svc.listAddressRules() }, json);
      break;
    case "unrule": {
      const ruleId = positional[0];
      if (!ruleId) {
        exitError("Rule ID is required");
        return;
      }
      if (svc.removeRule(ruleId)) {
        output({ ok: true, ruleId, action: "removed" }, json);
      } else {
        exitError(`No rule found matching "${ruleId}"`);
      }
      break;
    }
    default:
      exitError(
        "Usage: vellum email guardrails <get|set|block|allow|rules|unrule>",
      );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function email(): Promise<void> {
  const args = process.argv.slice(3); // everything after "email"

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    return;
  }

  // Check for top-level --json flag
  const jsonIdx = args.indexOf("--json");
  const json = jsonIdx !== -1;
  const filteredArgs = json
    ? [...args.slice(0, jsonIdx), ...args.slice(jsonIdx + 1)]
    : args;

  const subcommand = filteredArgs[0];
  const subArgs = filteredArgs.slice(1);

  switch (subcommand) {
    case "status":
      await handleStatus(json);
      break;
    case "setup":
      await handleSetup(subArgs, json);
      break;
    case "inbox":
      await handleInbox(subArgs, json);
      break;
    case "draft":
      await handleDraft(subArgs, json);
      break;
    case "inbound":
      await handleInbound(subArgs, json);
      break;
    case "thread":
      await handleThread(subArgs, json);
      break;
    case "guardrails":
      handleGuardrails(subArgs, json);
      break;
    default:
      exitError(`Unknown email subcommand: ${subcommand}`);
      printUsage();
  }
}
