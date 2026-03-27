import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Command } from "commander";

import { credentialKey } from "../../../security/credential-key.js";
import { getSignalsDir } from "../../../util/platform.js";
import {
  getSecureKeyViaDaemon,
  setSecureKeyViaDaemon,
} from "../../lib/daemon-credential-client.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Credential store keys
// ---------------------------------------------------------------------------

const CREDENTIAL_KEYS = {
  baseUrl: { service: "vellum", field: "platform_base_url" },
  apiKey: { service: "vellum", field: "assistant_api_key" },
  assistantId: { service: "vellum", field: "platform_assistant_id" },
  organizationId: { service: "vellum", field: "platform_organization_id" },
  userId: { service: "vellum", field: "platform_user_id" },
} as const;

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPlatformConnectCommand(platform: Command): void {
  platform
    .command("connect")
    .description(
      "Connect this assistant to the Vellum Platform by storing credentials",
    )
    .option("--base-url <url>", "Vellum Platform base URL")
    .option("--api-key <key>", "Assistant API key for the platform")
    .option("--assistant-id <id>", "Platform assistant ID")
    .option("--organization-id <id>", "Platform organization ID")
    .option("--user-id <id>", "Platform user ID")
    .addHelpText(
      "after",
      `
Initiates a platform connection flow. When called with --base-url and
--api-key, credentials are stored directly. When called without flags,
a signal is sent to open the platform login screen on connected clients.

Use 'assistant platform status' to check the current connection state and
'assistant platform disconnect' to remove stored credentials.

Examples:
  $ assistant platform connect
  $ assistant platform connect --base-url https://platform.vellum.ai --api-key vak_xxx
  $ assistant platform connect --base-url https://platform.vellum.ai --api-key vak_xxx --assistant-id asst-123 --json`,
    )
    .action(
      async (
        opts: {
          baseUrl?: string;
          apiKey?: string;
          assistantId?: string;
          organizationId?: string;
          userId?: string;
        },
        cmd: Command,
      ) => {
        const jsonMode = shouldOutputJson(cmd);

        const writeError = (error: string): void => {
          writeOutput(cmd, { ok: false, error });
          process.exitCode = 1;
        };

        try {
          // Check if already connected
          const existingUrl = await getSecureKeyViaDaemon(
            credentialKey(
              CREDENTIAL_KEYS.baseUrl.service,
              CREDENTIAL_KEYS.baseUrl.field,
            ),
          );
          const existingApiKey = await getSecureKeyViaDaemon(
            credentialKey(
              CREDENTIAL_KEYS.apiKey.service,
              CREDENTIAL_KEYS.apiKey.field,
            ),
          );

          const alreadyConnected = !!existingUrl && !!existingApiKey;

          if (alreadyConnected) {
            writeOutput(cmd, {
              ok: true,
              alreadyConnected: true,
              baseUrl: existingUrl,
            });

            if (!jsonMode) {
              log.info(
                `Already connected to platform at ${existingUrl}. ` +
                  `Run 'assistant platform disconnect' first to reconnect.`,
              );
            }
            return;
          }

          // ---------------------------------------------------------------
          // If no flags provided, emit a signal for the daemon to navigate
          // connected clients to the settings login screen.
          // ---------------------------------------------------------------
          if (!opts.baseUrl && !opts.apiKey) {
            const signalsDir = getSignalsDir();
            mkdirSync(signalsDir, { recursive: true });
            writeFileSync(
              join(signalsDir, "emit-event"),
              JSON.stringify({ type: "navigate_settings", tab: "General" }),
            );

            writeOutput(cmd, { ok: true, navigatedToSettings: true });

            if (!jsonMode) {
              log.info(
                "Opening the platform login screen on connected clients. " +
                  "Please complete the sign-in flow in the app.",
              );
            }
            return;
          }

          // ---------------------------------------------------------------
          // Validate required flags
          // ---------------------------------------------------------------
          if (!opts.baseUrl || !opts.apiKey) {
            writeError(
              "--base-url and --api-key are required.\n\n" +
                "Usage: assistant platform connect --base-url <url> --api-key <key>\n" +
                "Run 'assistant platform connect --help' for more details.",
            );
            return;
          }

          // ---------------------------------------------------------------
          // Validate base URL format
          // ---------------------------------------------------------------
          let normalizedBaseUrl: string;
          try {
            const parsed = new URL(opts.baseUrl);
            normalizedBaseUrl = parsed.origin;
          } catch {
            writeError(
              `Invalid base URL: "${opts.baseUrl}". Expected a valid URL (e.g. https://platform.vellum.ai).`,
            );
            return;
          }

          // ---------------------------------------------------------------
          // Store credentials
          // ---------------------------------------------------------------
          const stores: Array<{
            key: (typeof CREDENTIAL_KEYS)[keyof typeof CREDENTIAL_KEYS];
            value: string;
          }> = [
            { key: CREDENTIAL_KEYS.baseUrl, value: normalizedBaseUrl },
            { key: CREDENTIAL_KEYS.apiKey, value: opts.apiKey.trim() },
          ];

          if (opts.assistantId) {
            stores.push({
              key: CREDENTIAL_KEYS.assistantId,
              value: opts.assistantId.trim(),
            });
          }
          if (opts.organizationId) {
            stores.push({
              key: CREDENTIAL_KEYS.organizationId,
              value: opts.organizationId.trim(),
            });
          }
          if (opts.userId) {
            stores.push({
              key: CREDENTIAL_KEYS.userId,
              value: opts.userId.trim(),
            });
          }

          const failedKeys: string[] = [];
          for (const { key, value } of stores) {
            const stored = await setSecureKeyViaDaemon(
              "credential",
              `${key.service}:${key.field}`,
              value,
            );
            if (!stored) {
              failedKeys.push(`${key.service}:${key.field}`);
            }
          }

          if (failedKeys.length > 0) {
            writeError(`Failed to store credentials: ${failedKeys.join(", ")}`);
            return;
          }

          // ---------------------------------------------------------------
          // Output result
          // ---------------------------------------------------------------
          writeOutput(cmd, {
            ok: true,
            connected: true,
            baseUrl: normalizedBaseUrl,
          });

          if (!jsonMode) {
            log.info(`Connected to platform at ${normalizedBaseUrl}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(message);
        }
      },
    );
}

export { CREDENTIAL_KEYS };
