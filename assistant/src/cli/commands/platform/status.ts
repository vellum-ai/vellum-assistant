import type { Command } from "commander";

import { credentialKey } from "../../../security/credential-key.js";
import { getSecureKeyViaDaemon } from "../../lib/daemon-credential-client.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { CREDENTIAL_KEYS } from "./connect.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPlatformStatusCommand(platform: Command): void {
  platform
    .command("status")
    .description("Show platform connection status and stored credentials")
    .addHelpText(
      "after",
      `
Reads stored platform credentials and reports the current connection state.
Does not require the assistant daemon to be running.

Fields:
  connected       Whether platform credentials are stored (boolean)
  baseUrl         The platform gateway base URL
  assistantId     This assistant's platform UUID
  organizationId  The platform organization ID
  userId          The platform user ID

Use 'assistant platform connect' to store credentials and
'assistant platform disconnect' to remove them.

Examples:
  $ assistant platform status
  $ assistant platform status --json`,
    )
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      try {
        const baseUrl =
          (await getSecureKeyViaDaemon(
            credentialKey(
              CREDENTIAL_KEYS.baseUrl.service,
              CREDENTIAL_KEYS.baseUrl.field,
            ),
          )) ?? "";
        const hasApiKey = !!(await getSecureKeyViaDaemon(
          credentialKey(
            CREDENTIAL_KEYS.apiKey.service,
            CREDENTIAL_KEYS.apiKey.field,
          ),
        ));
        const assistantId =
          (
            await getSecureKeyViaDaemon(
              credentialKey(
                CREDENTIAL_KEYS.assistantId.service,
                CREDENTIAL_KEYS.assistantId.field,
              ),
            )
          )?.trim() ?? "";
        const organizationId =
          (
            await getSecureKeyViaDaemon(
              credentialKey(
                CREDENTIAL_KEYS.organizationId.service,
                CREDENTIAL_KEYS.organizationId.field,
              ),
            )
          )?.trim() ?? "";
        const userId =
          (
            await getSecureKeyViaDaemon(
              credentialKey(
                CREDENTIAL_KEYS.userId.service,
                CREDENTIAL_KEYS.userId.field,
              ),
            )
          )?.trim() ?? "";

        const connected = !!baseUrl && hasApiKey;

        const result = {
          connected,
          baseUrl: baseUrl || null,
          hasApiKey,
          assistantId: assistantId || null,
          organizationId: organizationId || null,
          userId: userId || null,
        };

        writeOutput(cmd, result);

        if (!shouldOutputJson(cmd)) {
          log.info(`Connected: ${connected}`);
          log.info(`Base URL: ${baseUrl || "(not set)"}`);
          log.info(`API key: ${hasApiKey ? "set" : "not set"}`);
          log.info(`Assistant ID: ${assistantId || "(not set)"}`);
          log.info(`Organization ID: ${organizationId || "(not set)"}`);
          log.info(`User ID: ${userId || "(not set)"}`);

          if (!connected) {
            log.info(
              `\nNot connected. Run 'assistant platform connect --url <url> --api-key <key>' to connect.`,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    });
}
