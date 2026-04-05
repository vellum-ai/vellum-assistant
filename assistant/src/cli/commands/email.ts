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
}
