import { readFileSync } from "node:fs";

import type { Command } from "commander";

import { VellumPlatformClient } from "../../platform/client.js";
import { getCliLogger } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

const log = getCliLogger("email");

export function registerEmailCommand(program: Command): void {
  const email = program
    .command("email")
    .description("Email channel operations")
    .option("--json", "Machine-readable compact JSON output");

  email.addHelpText(
    "after",
    `
Manage the assistant's email channel on the Vellum platform.

Examples:
  $ assistant email register mybot
  $ assistant email unregister --confirm
  $ assistant email send user@example.com -s "Hello" -b "Hi there"
  $ assistant email status
  $ assistant email register mybot --json`,
  );

  email
    .command("register <username>")
    .description("Register an @vellum.me email address for this assistant")
    .addHelpText(
      "after",
      `
Arguments:
  username   The local part of the email address (e.g. "mybot" → mybot@vellum.me)

Registers a new email address on the Vellum platform for the current
assistant. Each assistant can have one email address. The address is
immediately active for receiving inbound email.

Examples:
  $ assistant email register mybot
  ✓ Registered mybot@vellum.me

  $ assistant email register support --json
  {"address":"support@vellum.me","id":"...","created_at":"..."}`,
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
  Remove mybot@vellum.me? (y/N) y
  ✓ Unregistered mybot@vellum.me

  $ assistant email unregister --confirm
  ✓ Unregistered mybot@vellum.me

  $ assistant email unregister --json
  {"unregistered":"mybot@vellum.me"}`,
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
  Address: mybot@vellum.me
  Status:  active
  Sent:    12 / 100 (daily)

  $ assistant email status --json
  {"address":"mybot@vellum.me","status":"active","usage":{"sent_today":12,"daily_limit":100}}`,
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
    .command("send <to>")
    .description("Send an email from this assistant")
    .option("-s, --subject <text>", "Subject line")
    .option("-b, --body <text>", "Email body (plain text)")
    .option("-f, --file <path>", "Read body from file")
    .option("--html <path>", "HTML body file (optional)")
    .addHelpText(
      "after",
      `
Arguments:
  to   Recipient email address

Sends an email from the assistant's registered email address via the
Vellum runtime proxy. The "from" address is automatically resolved
from the assistant's registered email address.

Body source priority: --body flag > --file flag > stdin (if not a TTY).

Examples:
  $ assistant email send user@example.com -s "Hello" -b "Hi there"
  ✓ Sent to user@example.com (delivery_id: abc123)

  $ echo "Body text" | assistant email send user@example.com -s "Hello"
  ✓ Sent to user@example.com (delivery_id: def456)

  $ assistant email send user@example.com -s "Hello" -b "Hi" --json
  {"delivery_id":"abc123","status":"accepted"}`,
    )
    .action(
      async (
        to: string,
        opts: {
          subject?: string;
          body?: string;
          file?: string;
          html?: string;
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

          // 3. Resolve optional HTML body from file
          let html: string | undefined;
          if (opts.html) {
            html = readFileSync(opts.html, "utf-8");
          }

          // 4. Build payload
          const payload: Record<string, string> = {
            to,
            from_address: fromAddress,
            text,
          };
          if (opts.subject) payload.subject = opts.subject;
          if (html) payload.html = html;

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
            log.info(`✓ Sent to ${to} (delivery_id: ${data.delivery_id})`);
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
