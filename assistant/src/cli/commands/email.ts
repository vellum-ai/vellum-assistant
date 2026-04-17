import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Command } from "commander";

import { getAssistantDomain } from "../../config/env.js";
import { markdownToEmailHtml } from "../../email/html-renderer.js";
import { VellumPlatformClient } from "../../platform/client.js";
import { getCliLogger } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

const log = getCliLogger("email");

export function registerEmailCommand(program: Command): void {
  const domain = getAssistantDomain();
  const email = program
    .command("email")
    .description(
      `Get your own email address (@${domain}) — register, send, receive, and manage email natively`,
    )
    .option("--json", "Machine-readable compact JSON output");

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
    .description(`Register an @${domain} email address for this assistant`)
    .addHelpText(
      "after",
      `
Arguments:
  username   The local part of the email address (e.g. "mybot" → mybot@${domain})

Registers a new email address on the Vellum platform for the current
assistant. Each assistant can have one email address. The address is
immediately active for receiving inbound email.

Examples:
  $ assistant email register mybot
  ✓ Registered mybot@${domain}

  $ assistant email register support --json
  {"address":"support@${domain}","id":"...","created_at":"..."}`,
    )
    .action(async (username: string, _opts: unknown, cmd: Command) => {
      try {
        const client = await VellumPlatformClient.create();
        if (!client) {
          throw new Error(
            "Platform credentials not configured. Run: assistant platform connect",
          );
        }
        if (!client.platformAssistantId) {
          throw new Error(
            "Assistant ID not configured. Set PLATFORM_ASSISTANT_ID or run: assistant platform connect",
          );
        }

        const response = await client.fetch(
          `/v1/assistants/${client.platformAssistantId}/email-addresses/`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username }),
          },
        );

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          const detail =
            body.detail ??
            (Array.isArray(body.username) ? body.username[0] : undefined) ??
            (Array.isArray(body.assistant_id)
              ? body.assistant_id[0]
              : undefined) ??
            `HTTP ${response.status}`;
          throw new Error(String(detail));
        }

        const data = (await response.json()) as {
          id: string;
          address: string;
          created_at: string;
        };

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, data);
        } else {
          log.info(`✓ Registered ${data.address}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, { error: message });
        } else {
          log.error(`Error: ${message}`);
        }
        process.exitCode = 1;
      }
    });

  email
    .command("unregister")
    .description("Remove the email address registered for this assistant")
    .option("--confirm", "Skip confirmation prompt")
    .addHelpText(
      "after",
      `
Removes the email address currently registered for this assistant.
The address is deactivated immediately — inbound email will no longer
be delivered. The username enters a cooldown period and is not
immediately available for reuse.

Examples:
  $ assistant email unregister
  Remove mybot@${domain}? (y/N) y
  ✓ Unregistered mybot@${domain}

  $ assistant email unregister --confirm
  ✓ Unregistered mybot@${domain}

  $ assistant email unregister --json
  {"unregistered":"mybot@${domain}"}`,
    )
    .action(async (_opts: { confirm?: boolean }, cmd: Command) => {
      try {
        const client = await VellumPlatformClient.create();
        if (!client) {
          throw new Error(
            "Platform credentials not configured. Run: assistant platform connect",
          );
        }
        if (!client.platformAssistantId) {
          throw new Error(
            "Assistant ID not configured. Set PLATFORM_ASSISTANT_ID or run: assistant platform connect",
          );
        }

        const listResponse = await client.fetch(
          `/v1/assistants/${client.platformAssistantId}/email-addresses/`,
        );

        if (!listResponse.ok) {
          throw new Error(
            `Failed to list email addresses: HTTP ${listResponse.status}`,
          );
        }

        const listData = (await listResponse.json()) as {
          results: { id: string; address: string }[];
        };

        const addresses = listData.results ?? [];
        if (addresses.length === 0) {
          throw new Error("No email address registered for this assistant.");
        }

        const target = addresses[0];

        if (!_opts.confirm && !shouldOutputJson(cmd)) {
          const rl = await import("node:readline");
          const iface = rl.createInterface({
            input: process.stdin,
            output: process.stderr,
          });
          const answer = await new Promise<string>((resolve) => {
            iface.question(`Remove ${target.address}? (y/N) `, resolve);
          });
          iface.close();
          if (answer.trim().toLowerCase() !== "y") {
            log.info("Cancelled.");
            return;
          }
        }

        const deleteResponse = await client.fetch(
          `/v1/assistants/${client.platformAssistantId}/email-addresses/${target.id}/`,
          { method: "DELETE" },
        );

        if (!deleteResponse.ok) {
          const body = (await deleteResponse
            .json()
            .catch(() => ({}))) as Record<string, unknown>;
          const detail = body.detail ?? `HTTP ${deleteResponse.status}`;
          throw new Error(String(detail));
        }

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, { unregistered: target.address });
        } else {
          log.info(`✓ Unregistered ${target.address}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, { error: message });
        } else {
          log.error(`Error: ${message}`);
        }
        process.exitCode = 1;
      }
    });

  email
    .command("status")
    .description("Show email address info and usage for this assistant")
    .addHelpText(
      "after",
      `
Shows the email address registered for this assistant along with
current usage and quota information from the platform.

Examples:
  $ assistant email status
  Address: mybot@${domain}
  Status:  active
  Sent:    12 / 100 (daily)

  $ assistant email status --json
  {"address":"mybot@${domain}","status":"active","usage":{"sent_today":12,"daily_limit":100}}`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      try {
        const client = await VellumPlatformClient.create();
        if (!client) {
          throw new Error(
            "Platform credentials not configured. Run: assistant platform connect",
          );
        }
        if (!client.platformAssistantId) {
          throw new Error(
            "Assistant ID not configured. Set PLATFORM_ASSISTANT_ID or run: assistant platform connect",
          );
        }

        // 1. List addresses to find the registered one
        const listResponse = await client.fetch(
          `/v1/assistants/${client.platformAssistantId}/email-addresses/`,
        );

        if (!listResponse.ok) {
          throw new Error(
            `Failed to list email addresses: HTTP ${listResponse.status}`,
          );
        }

        const listData = (await listResponse.json()) as {
          results: { id: string; address: string }[];
        };

        const addresses = listData.results ?? [];
        if (addresses.length === 0) {
          throw new Error(
            "No email address registered for this assistant. Run: assistant email register <username>",
          );
        }

        const target = addresses[0];

        // 2. Fetch status/usage for this address
        const statusResponse = await client.fetch(
          `/v1/assistants/${client.platformAssistantId}/email-addresses/${target.id}/status/`,
        );

        if (!statusResponse.ok) {
          const body = (await statusResponse
            .json()
            .catch(() => ({}))) as Record<string, unknown>;
          const detail = body.detail ?? `HTTP ${statusResponse.status}`;
          throw new Error(String(detail));
        }

        const statusData = (await statusResponse.json()) as {
          address: string;
          status: string;
          usage: {
            sent_today: number;
            daily_limit: number;
            received_today: number;
          };
        };

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, statusData);
        } else {
          log.info(`Address: ${statusData.address}`);
          log.info(`Status:  ${statusData.status}`);
          if (statusData.usage) {
            log.info(
              `Sent:    ${statusData.usage.sent_today} / ${statusData.usage.daily_limit} (daily)`,
            );
            log.info(`Received today: ${statusData.usage.received_today}`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, { error: message });
        } else {
          log.error(`Error: ${message}`);
        }
        process.exitCode = 1;
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
    .option("--since <date>", "Only show messages since this date (ISO 8601)")
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
        try {
          const client = await VellumPlatformClient.create();
          if (!client) {
            throw new Error(
              "Platform credentials not configured. Run: assistant platform connect",
            );
          }
          if (!client.platformAssistantId) {
            throw new Error(
              "Assistant ID not configured. Set PLATFORM_ASSISTANT_ID or run: assistant platform connect",
            );
          }

          const params = new URLSearchParams();
          if (opts.direction && opts.direction !== "all") {
            params.set("direction", opts.direction);
          }
          if (opts.limit) {
            params.set("limit", opts.limit);
          }
          if (opts.since) {
            params.set("since", opts.since);
          }

          const qs = params.toString();
          const path = `/v1/assistants/${client.platformAssistantId}/emails/${qs ? `?${qs}` : ""}`;
          const response = await client.fetch(path);

          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as Record<
              string,
              unknown
            >;
            const detail = body.detail ?? `HTTP ${response.status}`;
            throw new Error(String(detail));
          }

          const data = (await response.json()) as {
            results: {
              id: string;
              direction: string;
              from_address: string;
              to_addresses: string[];
              subject: string;
              created_at: string;
            }[];
            count: number;
          };

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
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { error: message });
          } else {
            log.error(`Error: ${message}`);
          }
          process.exitCode = 1;
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
      `
Arguments:
  message-id   Email message ID (from \`assistant email list --json\`)

Downloads a specific email message by ID. The default format shows
headers and the plain-text body. Use --format html for the HTML body,
or --format json for the full message object.

Examples:
  $ assistant email download msg_abc123
  From:    user@example.com
  To:      mybot@${domain}
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
        try {
          const client = await VellumPlatformClient.create();
          if (!client) {
            throw new Error(
              "Platform credentials not configured. Run: assistant platform connect",
            );
          }
          if (!client.platformAssistantId) {
            throw new Error(
              "Assistant ID not configured. Set PLATFORM_ASSISTANT_ID or run: assistant platform connect",
            );
          }

          const response = await client.fetch(
            `/v1/assistants/${client.platformAssistantId}/emails/${messageId}/`,
          );

          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as Record<
              string,
              unknown
            >;
            const detail = body.detail ?? `HTTP ${response.status}`;
            throw new Error(String(detail));
          }

          const msg = (await response.json()) as {
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
          };

          const fmt = opts.format ?? "text";

          let content: string;
          if (fmt === "json" || shouldOutputJson(cmd)) {
            content = JSON.stringify(msg, null, 2) + "\n";
          } else if (fmt === "html") {
            if (!msg.body_html) {
              throw new Error("No HTML body available for this message.");
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
            writeFileSync(opts.output, content, "utf-8");
            if (!shouldOutputJson(cmd)) {
              log.info(`✓ Saved to ${opts.output}`);
            } else {
              writeOutput(cmd, { saved: opts.output, bytes: content.length });
            }
          } else {
            process.stdout.write(content);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { error: message });
          } else {
            log.error(`Error: ${message}`);
          }
          process.exitCode = 1;
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
        try {
          const client = await VellumPlatformClient.create();
          if (!client) {
            throw new Error(
              "Platform credentials not configured. Run: assistant platform connect",
            );
          }
          if (!client.platformAssistantId) {
            throw new Error(
              "Assistant ID not configured. Set PLATFORM_ASSISTANT_ID or run: assistant platform connect",
            );
          }

          // 1. Resolve the assistant's registered email address (the "from").
          const listResponse = await client.fetch(
            `/v1/assistants/${client.platformAssistantId}/email-addresses/`,
          );

          if (!listResponse.ok) {
            throw new Error(
              `Failed to list email addresses: HTTP ${listResponse.status}`,
            );
          }

          const listData = (await listResponse.json()) as {
            results: { id: string; address: string }[];
          };

          const addresses = listData.results ?? [];
          if (addresses.length === 0) {
            throw new Error(
              "No email address registered for this assistant. Run: assistant email register <username>",
            );
          }

          const fromAddress = addresses[0].address;

          // 2. Resolve body text: --body > --file > stdin
          let text = opts.body;
          if (!text && opts.file) {
            text = readFileSync(opts.file, "utf-8");
          }
          if (!text && !process.stdin.isTTY) {
            text = readFileSync("/dev/stdin", "utf-8");
          }
          if (!text) {
            throw new Error(
              "Email body is required. Use --body, --file, or pipe via stdin.",
            );
          }

          // 3. Resolve HTML body: explicit file > auto-generate from text
          let html: string | undefined;
          if (opts.html) {
            html = readFileSync(opts.html, "utf-8");
          } else {
            // Auto-generate HTML from the text body (markdown → email HTML).
            html = markdownToEmailHtml(text);
          }

          // 4. Build payload
          const payload: Record<string, unknown> = {
            to,
            from_address: fromAddress,
            text,
          };
          if (opts.subject) payload.subject = opts.subject;
          if (html) payload.html = html;
          if (opts.cc && opts.cc.length > 0) payload.cc = opts.cc;
          if (opts.bcc && opts.bcc.length > 0) payload.bcc = opts.bcc;
          if (opts.replyTo) payload.reply_to = opts.replyTo;

          // 5. Send via runtime proxy
          const response = await client.fetch("/v1/runtime-proxy/email/send/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as Record<
              string,
              unknown
            >;
            const detail = body.detail ?? `HTTP ${response.status}`;
            throw new Error(String(detail));
          }

          const data = (await response.json()) as {
            delivery_id: string;
            status: string;
          };

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, data);
          } else {
            log.info(
              `✓ Sent to ${to.join(", ")} (delivery_id: ${data.delivery_id})`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { error: message });
          } else {
            log.error(`Error: ${message}`);
          }
          process.exitCode = 1;
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
      try {
        const client = await VellumPlatformClient.create();
        if (!client) {
          throw new Error(
            "Platform credentials not configured. Run: assistant platform connect",
          );
        }
        if (!client.platformAssistantId) {
          throw new Error(
            "Assistant ID not configured. Set PLATFORM_ASSISTANT_ID or run: assistant platform connect",
          );
        }

        const assistantId = client.platformAssistantId;
        const basePath = `/v1/assistants/${assistantId}/emails/${messageId}/attachments`;

        if (opts.list) {
          // List mode — show attachment metadata without downloading
          const response = await client.fetch(`${basePath}/`);
          if (!response.ok) {
            const body = (await response
              .json()
              .catch(() => ({}))) as Record<string, unknown>;
            const detail = body.detail ?? `HTTP ${response.status}`;
            throw new Error(String(detail));
          }

          const data = (await response.json()) as {
            results: AttachmentMeta[];
          };

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
          throw new Error(
            "Specify an attachment ID, or use --all to download all attachments. Use --list to see available attachments.",
          );
        }

        // Ensure output directory exists
        const outDir = opts.output ?? ".";
        mkdirSync(outDir, { recursive: true });

        if (opts.all) {
          // Download all attachments
          const listResponse = await client.fetch(`${basePath}/`);
          if (!listResponse.ok) {
            const body = (await listResponse
              .json()
              .catch(() => ({}))) as Record<string, unknown>;
            const detail = body.detail ?? `HTTP ${listResponse.status}`;
            throw new Error(String(detail));
          }

          const listData = (await listResponse.json()) as {
            results: AttachmentMeta[];
          };

          const attachments = listData.results ?? [];
          if (attachments.length === 0) {
            throw new Error("No attachments for this message.");
          }

          const downloaded: { filename: string; size_bytes: number }[] = [];
          for (const att of attachments) {
            const dest = join(outDir, safeFilename(att.filename));
            await downloadAttachment(client, basePath, att.id, dest);
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
              log.info(`  - ${f.filename} (${formatBytes(f.size_bytes)})`);
            }
          }
        } else {
          // Download single attachment — first get metadata for the filename
          const metaResponse = await client.fetch(
            `${basePath}/${attachmentId}/`,
          );
          if (!metaResponse.ok) {
            const body = (await metaResponse
              .json()
              .catch(() => ({}))) as Record<string, unknown>;
            const detail = body.detail ?? `HTTP ${metaResponse.status}`;
            throw new Error(String(detail));
          }

          const meta = (await metaResponse.json()) as AttachmentMeta;
          const dest = join(outDir, safeFilename(meta.filename));
          await downloadAttachment(client, basePath, meta.id, dest);

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
        const message = err instanceof Error ? err.message : String(err);
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, { error: message });
        } else {
          log.error(`Error: ${message}`);
        }
        process.exitCode = 1;
      }
    },
  );
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
if (bytes < 1024) return `${bytes} B`;
if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeFilename(name: string): string {
// Strip path separators and null bytes — keep the basename only
return basename(name).replace(/[\x00/\\]/g, "_") || "attachment";
}

async function downloadAttachment(
client: VellumPlatformClient,
basePath: string,
attachmentId: string,
dest: string,
): Promise<void> {
const response = await client.fetch(
  `${basePath}/${attachmentId}/download/`,
);

if (!response.ok) {
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const detail = body.detail ?? `HTTP ${response.status}`;
  throw new Error(`Failed to download attachment: ${detail}`);
}

if (!response.body) {
  throw new Error("Empty response body from download endpoint.");
}

const fileStream = createWriteStream(dest);
await pipeline(response.body as unknown as Readable, fileStream);
}
