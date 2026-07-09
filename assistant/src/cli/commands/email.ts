import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

import type { Command } from "commander";

import {
  cliIpcCall,
  cliIpcCallStream,
  exitFromIpcResult,
} from "../../ipc/cli-client.js";
import { readStdinSync } from "../../util/read-stdin.js";
import { registerCommand } from "../lib/register-command.js";
import { getCliLogger } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

const loadModule = createRequire(import.meta.url);

const log = getCliLogger("email");

/**
 * Handle an IPC error in the email command. In --json mode, writes a
 * `{"error": "..."}` envelope to stdout so callers can parse it. In all
 * modes, sets a non-zero exit code without calling process.exit() so tests
 * using runAssistantCommandFull can inspect the exit code after the call.
 */
function handleEmailIpcError(
  r: { ok: false; error?: string; statusCode?: number },
  cmd: Command,
): void {
  const exitCode =
    r.statusCode == null
      ? 10
      : r.statusCode >= 500
        ? 3
        : r.statusCode >= 400
          ? 2
          : 1;
  if (shouldOutputJson(cmd)) {
    process.stdout.write(
      JSON.stringify({ error: r.error ?? "Unknown error" }) + "\n",
    );
    process.exitCode = exitCode;
    return;
  }
  exitFromIpcResult(r, cmd);
}

/** Loaded lazily: config/env pulls the full config-loader graph. */
function assistantDomain(): string {
  const { getAssistantDomain } = loadModule(
    "../../config/env.js",
  ) as typeof import("../../config/env.js");
  return getAssistantDomain();
}

export function registerEmailCommand(program: Command): void {
  registerCommand(program, {
    name: "email",
    transport: "ipc",
    description:
      "Get your own email address — register, send, receive, and manage email natively",
    build: (email) => {
      // Keep the --json option at the email namespace level
      email.option("--json", "Machine-readable compact JSON output");

      email.addHelpText(
        "after",
        `
Set up and manage this assistant's native email address on the Vellum
platform. No third-party email provider or browser sign-up needed.

Examples:
  $ assistant email register mybot
  $ assistant email unregister --confirm
  $ assistant email send user@example.com -s "Hello" -b "Hi there"
  $ assistant email status
  $ assistant email list
  $ assistant email attachment msg_abc1 --list
  $ assistant email attachment msg_abc1 att_xyz1
  $ assistant email register mybot --json`,
      );

      email
        .command("register <username>")
        .description("Register an email address for this assistant")
        .addHelpText(
          "after",
          () => `
Arguments:
  username   The local part of the email address (e.g. "mybot" → mybot@${assistantDomain()})

Registers a new email address on the Vellum platform for the current
assistant. Each assistant can have one email address. The address is
immediately active for receiving inbound email.

Examples:
  $ assistant email register mybot
  ✓ Registered mybot@${assistantDomain()}

  $ assistant email register support --json
  {"address":"support@${assistantDomain()}","id":"...","created_at":"..."}`,
        )
        .action(async (username: string, _opts: unknown, cmd: Command) => {
          const r = await cliIpcCall<{
            id: string;
            address: string;
            created_at: string;
          }>("email_register", { body: { username } });
          if (!r.ok) {
            return handleEmailIpcError(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          }
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, r.result);
          } else {
            log.info(`✓ Registered ${r.result!.address}`);
          }
        });

      email
        .command("unregister")
        .description("Remove the email address registered for this assistant")
        .option("--confirm", "Skip confirmation prompt")
        .addHelpText(
          "after",
          () => `
Removes the email address currently registered for this assistant.
The address is deactivated immediately — inbound email will no longer
be delivered. The username enters a cooldown period and is not
immediately available for reuse.

Examples:
  $ assistant email unregister
  Remove mybot@${assistantDomain()}? (y/N) y
  ✓ Unregistered mybot@${assistantDomain()}

  $ assistant email unregister --confirm
  ✓ Unregistered mybot@${assistantDomain()}

  $ assistant email unregister --json
  {"unregistered":"mybot@${assistantDomain()}"}`,
        )
        .action(async (_opts: { confirm?: boolean }, cmd: Command) => {
          if (!_opts.confirm && !shouldOutputJson(cmd)) {
            const rl = await import("node:readline");
            // We need to get the address to show in the prompt, but we can't
            // know it without making an IPC call. Use a generic prompt here.
            const iface = rl.createInterface({
              input: process.stdin,
              output: process.stderr,
            });
            const answer = await new Promise<string>((resolve) => {
              iface.question(
                `Remove registered email address? (y/N) `,
                resolve,
              );
            });
            iface.close();
            if (answer.trim().toLowerCase() !== "y") {
              log.info("Cancelled.");
              return;
            }
          }
          const r = await cliIpcCall<{ unregistered: string }>(
            "email_unregister",
            {},
          );
          if (!r.ok) {
            return handleEmailIpcError(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          }
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, r.result);
          } else {
            log.info(`✓ Unregistered ${r.result!.unregistered}`);
          }
        });

      email
        .command("status")
        .description("Show email address info and usage for this assistant")
        .addHelpText(
          "after",
          () => `
Shows the email address registered for this assistant along with
current usage and quota information from the platform.

Examples:
  $ assistant email status
  Address:  hi@mybot.${assistantDomain()}
  Status:   active
  Since:    2026-04-15
  Sent:     12 / 100 (daily)
  Received: 5 (today)
  Monthly:  42 sent, 18 received

  $ assistant email status --json
  {"address":"hi@mybot.${assistantDomain()}","status":"active","created_at":"2026-04-15T...","usage":{...}}`,
        )
        .action(async (_opts: unknown, cmd: Command) => {
          const r = await cliIpcCall<{
            address: string;
            status: string;
            created_at: string;
            usage: {
              sent_today: number;
              daily_limit: number;
              received_today: number;
              sent_this_month: number;
              received_this_month: number;
            };
          }>("email_status", {});
          if (!r.ok) {
            return handleEmailIpcError(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          }
          const statusData = r.result!;
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, statusData);
          } else {
            log.info(`Address:  ${statusData.address}`);
            log.info(`Status:   ${statusData.status}`);
            log.info(`Since:    ${statusData.created_at.split("T")[0]}`);
            if (statusData.usage) {
              log.info(
                `Sent:     ${statusData.usage.sent_today} / ${statusData.usage.daily_limit} (daily)`,
              );
              log.info(`Received: ${statusData.usage.received_today} (today)`);
              log.info(
                `Monthly:  ${statusData.usage.sent_this_month} sent, ${statusData.usage.received_this_month} received`,
              );
            }
          }
        });

      email
        .command("list")
        .description("List received and sent emails for this assistant")
        .option(
          "-d, --direction <direction>",
          "Filter by direction: inbound, outbound, or all",
          "all",
        )
        .option("-l, --limit <count>", "Maximum number of results", "20")
        .option(
          "--since <date>",
          "Only show messages since this date (ISO 8601)",
        )
        .addHelpText(
          "after",
          `
Lists email messages for this assistant. Shows subject, from, to,
direction, and timestamp for each message.

Examples:
  $ assistant email list
  $ assistant email list --direction inbound --limit 5
  $ assistant email list --since 2026-04-01 --json`,
        )
        .action(
          async (
            opts: {
              direction?: string;
              limit?: string;
              since?: string;
            },
            cmd: Command,
          ) => {
            const params: Record<string, string> = {};
            if (opts.direction && opts.direction !== "all") {
              params.direction = opts.direction;
            }
            if (opts.limit) {
              params.limit = opts.limit;
            }
            if (opts.since) {
              params.since = opts.since;
            }

            const r = await cliIpcCall<{
              results: {
                id: string;
                direction: string;
                from_address: string;
                to_addresses: string[];
                subject: string;
                created_at: string;
              }[];
              count: number;
            }>("email_list", { queryParams: params });
            if (!r.ok) {
              return handleEmailIpcError(
                { ok: false, error: r.error, statusCode: r.statusCode },
                cmd,
              );
            }
            const data = r.result!;
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, data);
            } else {
              const messages = data.results ?? [];
              if (messages.length === 0) {
                log.info("No email messages found.");
              } else {
                for (const msg of messages) {
                  const dir = msg.direction === "inbound" ? "←" : "→";
                  const to = Array.isArray(msg.to_addresses)
                    ? msg.to_addresses.join(", ")
                    : "";
                  const date = new Date(msg.created_at).toLocaleString();
                  log.info(
                    `${dir} ${date}  ${msg.from_address} → ${to}  "${msg.subject || "(no subject)"}"`,
                  );
                }
                log.info(`\n${data.count} total message(s)`);
              }
            }
          },
        );

      email
        .command("download <message-id>")
        .description("Download a specific email message")
        .option(
          "--format <type>",
          "Output format: text, html, json (default: text)",
          "text",
        )
        .option("-o, --output <path>", "Write to file instead of stdout")
        .addHelpText(
          "after",
          () => `
Arguments:
  message-id   Email message ID (from \`assistant email list --json\`)

Downloads a specific email message by ID. The default format shows
headers and the plain-text body. Use --format html for the HTML body,
or --format json for the full message object.

Examples:
  $ assistant email download msg_abc123
  From:    user@example.com
  To:      mybot@${assistantDomain()}
  Subject: Hello
  Date:    2026-04-05 12:00:00

  Hi, this is a test message.

  $ assistant email download msg_abc123 --format json
  {"id":"msg_abc123","direction":"inbound",...}

  $ assistant email download msg_abc123 -o email.txt
  ✓ Saved to email.txt`,
        )
        .action(
          async (
            messageId: string,
            opts: {
              format?: string;
              output?: string;
            },
            cmd: Command,
          ) => {
            const r = await cliIpcCall<{
              id: string;
              direction: string;
              from_address: string;
              to_addresses: string[];
              subject: string;
              body_text: string;
              body_html: string;
              in_reply_to: string;
              references: string[];
              created_at: string;
            }>("email_download", { queryParams: { messageId } });
            if (!r.ok) {
              return handleEmailIpcError(
                { ok: false, error: r.error, statusCode: r.statusCode },
                cmd,
              );
            }
            const msg = r.result!;

            const fmt = opts.format ?? "text";

            let content: string;
            if (fmt === "json" || shouldOutputJson(cmd)) {
              content = JSON.stringify(msg, null, 2) + "\n";
            } else if (fmt === "html") {
              if (!msg.body_html) {
                log.error("No HTML body available for this message.");
                process.exitCode = 1;
                return;
              }
              content = msg.body_html;
            } else {
              // text format: headers + body
              const to = Array.isArray(msg.to_addresses)
                ? msg.to_addresses.join(", ")
                : "";
              const date = new Date(msg.created_at).toLocaleString();
              const lines = [
                `From:    ${msg.from_address}`,
                `To:      ${to}`,
                `Subject: ${msg.subject || "(no subject)"}`,
                `Date:    ${date}`,
              ];
              if (msg.in_reply_to) {
                lines.push(`In-Reply-To: ${msg.in_reply_to}`);
              }
              lines.push("", msg.body_text || "(no plain-text body)");
              content = lines.join("\n") + "\n";
            }

            if (opts.output) {
              try {
                writeFileSync(opts.output, content, "utf-8");
              } catch (err) {
                log.error(
                  `Failed to write --output ${opts.output}: ${err instanceof Error ? err.message : String(err)}`,
                );
                process.exitCode = 1;
                return;
              }
              if (!shouldOutputJson(cmd)) {
                log.info(`✓ Saved to ${opts.output}`);
              } else {
                writeOutput(cmd, { saved: opts.output, bytes: content.length });
              }
            } else {
              process.stdout.write(content);
            }
          },
        );

      email
        .command("send <to...>")
        .description("Send an email from this assistant")
        .option("-s, --subject <text>", "Subject line")
        .option("-b, --body <text>", "Email body (plain text)")
        .option("-f, --file <path>", "Read body from file")
        .option("--html <path>", "HTML body file (optional)")
        .option(
          "--cc <address>",
          "CC recipient (repeatable)",
          (val: string, prev: string[]) => [...prev, val],
          [] as string[],
        )
        .option(
          "--bcc <address>",
          "BCC recipient (repeatable)",
          (val: string, prev: string[]) => [...prev, val],
          [] as string[],
        )
        .option(
          "--reply-to <email_id>",
          "Reply to an email by its ID (auto-resolves threading headers and subject)",
        )
        .addHelpText(
          "after",
          `
Arguments:
  to   Recipient email address(es) — one or more

Sends an email from the assistant's registered email address via the
Vellum runtime proxy. The "from" address is automatically resolved
from the assistant's registered email address.

Body source priority: --body flag > --file flag > stdin (if not a TTY).

When --reply-to is provided, the platform auto-resolves In-Reply-To,
References, and Subject headers from the referenced email. You can
still override subject with -s.

Examples:
  $ assistant email send user@example.com -s "Hello" -b "Hi there"
  ✓ Sent to user@example.com (delivery_id: abc123)

  $ assistant email send a@example.com b@example.com --cc c@example.com -s "Team" -b "Hi all"
  ✓ Sent to a@example.com, b@example.com (delivery_id: abc123)

  $ assistant email send user@example.com --bcc boss@example.com -s "FYI" -b "See below"
  ✓ Sent to user@example.com (delivery_id: def456)

  $ assistant email send user@example.com -b "Thanks!" --reply-to 019d96e4-e5d2-7201-890e-04a21e8f95bb
  ✓ Sent to user@example.com (delivery_id: ghi789)

  $ assistant email send user@example.com -s "Hello" -b "Hi" --json
  {"delivery_id":"abc123","status":"accepted"}`,
        )
        .action(
          async (
            to: string[],
            opts: {
              subject?: string;
              body?: string;
              file?: string;
              html?: string;
              cc?: string[];
              bcc?: string[];
              replyTo?: string;
            },
            cmd: Command,
          ) => {
            // Resolve body text: --body > --file > stdin
            let text = opts.body;
            if (!text && opts.file) {
              try {
                text = readFileSync(opts.file, "utf-8");
              } catch (err) {
                log.error(
                  `Failed to read --file ${opts.file}: ${err instanceof Error ? err.message : String(err)}`,
                );
                process.exitCode = 1;
                return;
              }
            }
            if (!text && !process.stdin.isTTY) {
              try {
                text = readStdinSync();
              } catch (err) {
                log.error(
                  `Failed to read body from stdin: ${err instanceof Error ? err.message : String(err)}`,
                );
                process.exitCode = 1;
                return;
              }
            }
            if (!text) {
              log.error(
                "Email body is required. Use --body, --file, or pipe via stdin.",
              );
              process.exitCode = 1;
              return;
            }

            // Read HTML file if --html given; pass raw content to route
            let html: string | undefined;
            if (opts.html) {
              try {
                html = readFileSync(opts.html, "utf-8");
              } catch (err) {
                log.error(
                  `Failed to read --html ${opts.html}: ${err instanceof Error ? err.message : String(err)}`,
                );
                process.exitCode = 1;
                return;
              }
            }

            const params: Record<string, unknown> = { to, text };
            if (opts.subject) {
              params.subject = opts.subject;
            }
            if (html) {
              params.html = html;
            }
            if (opts.cc && opts.cc.length > 0) {
              params.cc = opts.cc;
            }
            if (opts.bcc && opts.bcc.length > 0) {
              params.bcc = opts.bcc;
            }
            if (opts.replyTo) {
              params.reply_to = opts.replyTo;
            }

            const r = await cliIpcCall<{ delivery_id: string; status: string }>(
              "email_send",
              { body: params },
            );
            if (!r.ok) {
              return handleEmailIpcError(
                { ok: false, error: r.error, statusCode: r.statusCode },
                cmd,
              );
            }
            const data = r.result!;
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, data);
            } else {
              log.info(
                `✓ Sent to ${to.join(", ")} (delivery_id: ${data.delivery_id})`,
              );
            }
          },
        );

      email
        .command("attachment <message-id> [attachment-id]")
        .description("Download email attachments")
        .option("--all", "Download all attachments for the message")
        .option(
          "-o, --output <dir>",
          "Output directory (default: current directory)",
          ".",
        )
        .option("--list", "List attachments without downloading")
        .addHelpText(
          "after",
          `
Arguments:
message-id      Email message ID (from \`assistant email list --json\`)
attachment-id   Attachment ID (optional — required unless --all or --list)

Download one or all attachments from a specific email message. Use
--list to see available attachments without downloading.

Examples:
$ assistant email attachment msg_abc1 --list
$ assistant email attachment msg_abc1 att_xyz1
$ assistant email attachment msg_abc1 att_xyz1 -o ./downloads/
$ assistant email attachment msg_abc1 --all
$ assistant email attachment msg_abc1 --all -o ./attachments/
$ assistant email attachment msg_abc1 --list --json`,
        )
        .action(
          async (
            messageId: string,
            attachmentId: string | undefined,
            opts: {
              all?: boolean;
              output?: string;
              list?: boolean;
            },
            cmd: Command,
          ) => {
            if (opts.list) {
              // List mode — show attachment metadata without downloading
              const r = await cliIpcCall<{ results: AttachmentMeta[] }>(
                "email_attachment_list",
                { queryParams: { messageId } },
              );
              if (!r.ok) {
                return handleEmailIpcError(
                  { ok: false, error: r.error, statusCode: r.statusCode },
                  cmd,
                );
              }
              const data = r.result!;
              if (shouldOutputJson(cmd)) {
                writeOutput(cmd, data);
              } else {
                const attachments = data.results ?? [];
                if (attachments.length === 0) {
                  log.info("No attachments for this message.");
                } else {
                  for (const att of attachments) {
                    log.info(
                      `  ${att.id}  ${att.filename}  (${att.content_type}, ${formatBytes(att.size_bytes)})`,
                    );
                  }
                  log.info(`\n${attachments.length} attachment(s)`);
                }
              }
              return;
            }

            if (!opts.all && !attachmentId) {
              log.error(
                "Specify an attachment ID, or use --all to download all. Use --list to see available.",
              );
              process.exitCode = 1;
              return;
            }

            // Ensure output directory exists and download attachment(s)
            const outDir = opts.output ?? ".";
            try {
              mkdirSync(outDir, { recursive: true });
            } catch (err) {
              log.error(
                `Failed to create output directory ${outDir}: ${err instanceof Error ? err.message : String(err)}`,
              );
              process.exitCode = 1;
              return;
            }

            try {
              if (opts.all) {
                // Download all attachments — list first to get filenames
                const listR = await cliIpcCall<{ results: AttachmentMeta[] }>(
                  "email_attachment_list",
                  { queryParams: { messageId } },
                );
                if (!listR.ok) {
                  return handleEmailIpcError(
                    {
                      ok: false,
                      error: listR.error,
                      statusCode: listR.statusCode,
                    },
                    cmd,
                  );
                }
                const attachments = listR.result!.results ?? [];
                if (attachments.length === 0) {
                  log.error("No attachments for this message.");
                  process.exitCode = 1;
                  return;
                }

                const downloaded: { filename: string; size_bytes: number }[] =
                  [];
                for (const att of attachments) {
                  const dest = join(outDir, safeFilename(att.filename));
                  await streamDownloadAttachment(att.id, messageId, dest);
                  downloaded.push({
                    filename: att.filename,
                    size_bytes: att.size_bytes,
                  });
                }

                if (shouldOutputJson(cmd)) {
                  writeOutput(cmd, {
                    downloaded: downloaded.length,
                    directory: outDir,
                    files: downloaded,
                  });
                } else {
                  log.info(
                    `✓ Downloaded ${downloaded.length} attachment(s) to ${outDir}`,
                  );
                  for (const f of downloaded) {
                    log.info(
                      `  - ${f.filename} (${formatBytes(f.size_bytes)})`,
                    );
                  }
                }
              } else {
                // Download single attachment — look up metadata from the list first
                const listR = await cliIpcCall<{ results: AttachmentMeta[] }>(
                  "email_attachment_list",
                  { queryParams: { messageId } },
                );
                if (!listR.ok) {
                  return handleEmailIpcError(
                    {
                      ok: false,
                      error: listR.error,
                      statusCode: listR.statusCode,
                    },
                    cmd,
                  );
                }
                const meta = (listR.result!.results ?? []).find(
                  (a) => a.id === attachmentId,
                );
                if (!meta) {
                  log.error(`Attachment not found: ${attachmentId}`);
                  process.exitCode = 2;
                  return;
                }
                const dest = join(outDir, safeFilename(meta.filename));
                await streamDownloadAttachment(attachmentId!, messageId, dest);

                if (shouldOutputJson(cmd)) {
                  writeOutput(cmd, {
                    filename: meta.filename,
                    size_bytes: meta.size_bytes,
                    saved: dest,
                  });
                } else {
                  log.info(
                    `✓ Downloaded ${meta.filename} (${formatBytes(meta.size_bytes)})`,
                  );
                }
              }
            } catch (err) {
              log.error(
                `Failed to download attachment: ${err instanceof Error ? err.message : String(err)}`,
              );
              process.exitCode = 1;
              return;
            }
          },
        );
    },
  });
}

interface AttachmentMeta {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  content_id: string;
  created_at: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeFilename(name: string): string {
  // Strip path separators and null bytes — keep the basename only
  return basename(name).replace(/[\x00/\\]/g, "_") || "attachment";
}

async function streamDownloadAttachment(
  attachmentId: string,
  messageId: string,
  dest: string,
): Promise<void> {
  const r = await cliIpcCallStream("email_attachment_get", {
    queryParams: { messageId, attachmentId },
  });
  if (!r.ok) {
    throw new Error(r.error ?? "Stream failed");
  }

  const fileStream = createWriteStream(dest);
  const reader = r.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      await new Promise<void>((resolve, reject) =>
        fileStream.write(value, (err) => (err ? reject(err) : resolve())),
      );
    }
    await new Promise<void>((resolve, reject) =>
      fileStream.close((err) => (err ? reject(err) : resolve())),
    );
  } catch (err) {
    r.abort();
    fileStream.destroy();
    throw err;
  }
}
