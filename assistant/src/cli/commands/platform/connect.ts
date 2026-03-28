import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Command } from "commander";

import { credentialKey } from "../../../security/credential-key.js";
import { getSignalsDir } from "../../../util/platform.js";
import { getSecureKeyViaDaemon } from "../../lib/daemon-credential-client.js";
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
    .addHelpText(
      "after",
      `
Initiates a platform connection flow. Emits a signal for connected clients
to show a platform login UI where the user can sign in and store credentials.

Use 'assistant platform status' to check the current connection state and
'assistant platform disconnect' to remove stored credentials.

Examples:
  $ assistant platform connect
  $ assistant platform connect --json`,
    )
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
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

        // Emit a signal for the daemon to show the platform login UI
        // on connected clients.
        const signalsDir = getSignalsDir();
        mkdirSync(signalsDir, { recursive: true });
        writeFileSync(
          join(signalsDir, "emit-event"),
          JSON.stringify({ type: "show_platform_login" }),
        );

        writeOutput(cmd, { ok: true, showPlatformLogin: true });

        if (!jsonMode) {
          log.info(
            "Showing the platform login screen on connected clients. " +
              "Please complete the sign-in flow in the app.",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeError(message);
      }
    });
}

export { CREDENTIAL_KEYS };
