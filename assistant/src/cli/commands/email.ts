/**
 * CLI command group: `assistant email`
 *
 * Vellum-native email operations backed by the platform API.
 * Subcommands are added incrementally as the email channel matures.
 *
 * Legacy AgentMail-based commands are available under `assistant email legacy`.
 */

import type { Command } from "commander";

import {
  getPlatformAssistantId,
  getPlatformBaseUrl,
} from "../../config/env.js";
import { credentialKey } from "../../security/credential-key.js";
import { getSecureKeyAsync } from "../../security/secure-keys.js";
import { getCliLogger } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { registerLegacyEmailCommand } from "./legacy-email.js";

const log = getCliLogger("email");

// ---------------------------------------------------------------------------
// Platform API helpers
// ---------------------------------------------------------------------------

interface PlatformContext {
  baseUrl: string;
  assistantId: string;
  apiKey: string;
}

async function resolvePlatformContext(): Promise<PlatformContext> {
  const baseUrl = getPlatformBaseUrl().replace(/\/+$/, "");
  const assistantId = getPlatformAssistantId();
  const apiKey =
    (await getSecureKeyAsync(credentialKey("vellum", "assistant_api_key"))) ??
    "";

  if (!baseUrl) {
    throw new Error(
      "Platform URL not configured. Run: assistant platform connect",
    );
  }
  if (!assistantId) {
    throw new Error(
      "Assistant ID not configured. Set PLATFORM_ASSISTANT_ID or run: assistant platform connect",
    );
  }
  if (!apiKey) {
    throw new Error(
      "Assistant API key not found. Run: assistant platform connect",
    );
  }

  return { baseUrl, assistantId, apiKey };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

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

  // =========================================================================
  // register — claim an @vellum.me address for this assistant
  // =========================================================================

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
        const ctx = await resolvePlatformContext();
        const url = `${ctx.baseUrl}/v1/assistants/${ctx.assistantId}/email-addresses/`;

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Api-Key ${ctx.apiKey}`,
          },
          body: JSON.stringify({ username }),
        });

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

  // =========================================================================
  // Legacy subcommand — preserves AgentMail-based commands
  // =========================================================================

  registerLegacyEmailCommand(email);
}
