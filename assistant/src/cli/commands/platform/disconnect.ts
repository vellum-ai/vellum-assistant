import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Command } from "commander";

import { isPlatformRemote } from "../../../config/env-registry.js";
import { credentialKey } from "../../../security/credential-key.js";
import { getSecureKeyAsync } from "../../../security/secure-keys.js";
import { getSignalsDir } from "../../../util/platform.js";
import { deleteSecureKeyViaDaemon } from "../../lib/daemon-credential-client.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { CREDENTIAL_KEYS } from "./connect.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPlatformDisconnectCommand(platform: Command): void {
  platform
    .command("disconnect")
    .description(
      "Disconnect from the Vellum Platform by removing stored credentials",
    )
    .addHelpText(
      "after",
      `
Removes all stored platform credentials from the assistant's secure
credential store. After disconnecting, platform-managed features (managed
proxy, managed OAuth, callback routing) will no longer be available until
you reconnect with 'assistant platform connect'.

Use 'assistant platform status' to check the current connection state
before disconnecting.

Examples:
  $ assistant platform disconnect
  $ assistant platform disconnect --json`,
    )
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const jsonMode = shouldOutputJson(cmd);

      const writeError = (error: string): void => {
        writeOutput(cmd, { ok: false, error });
        process.exitCode = 1;
      };

      try {
        // ---------------------------------------------------------------
        // 1. Reject if running inside a platform host
        // ---------------------------------------------------------------
        if (isPlatformRemote()) {
          writeError(
            "Cannot disconnect from the platform on a platform-hosted assistant.",
          );
          return;
        }

        // ---------------------------------------------------------------
        // 2. Check if connected
        // ---------------------------------------------------------------
        const baseUrl = await getSecureKeyAsync(
          credentialKey(
            CREDENTIAL_KEYS.baseUrl.service,
            CREDENTIAL_KEYS.baseUrl.field,
          ),
        );
        const apiKey = await getSecureKeyAsync(
          credentialKey(
            CREDENTIAL_KEYS.apiKey.service,
            CREDENTIAL_KEYS.apiKey.field,
          ),
        );

        if (!baseUrl && !apiKey) {
          writeError(
            "Not connected to a platform. Nothing to disconnect.\n\n" +
              "Run 'assistant platform status' to check connection state.",
          );
          return;
        }

        // ---------------------------------------------------------------
        // 3. Delete all platform credentials
        // ---------------------------------------------------------------
        const keysToDelete = [
          CREDENTIAL_KEYS.baseUrl,
          CREDENTIAL_KEYS.apiKey,
          CREDENTIAL_KEYS.assistantId,
          CREDENTIAL_KEYS.organizationId,
          CREDENTIAL_KEYS.userId,
        ] as const;

        const failedKeys: string[] = [];
        for (const key of keysToDelete) {
          const delResult = await deleteSecureKeyViaDaemon(
            "credential",
            `${key.service}:${key.field}`,
          );
          if (delResult.result === "error") {
            const detail = delResult.error ? `: ${delResult.error}` : "";
            failedKeys.push(`${key.service}:${key.field}${detail}`);
          }
        }

        if (failedKeys.length > 0) {
          writeError(`Failed to delete credentials: ${failedKeys.join("; ")}`);
          return;
        }

        // ---------------------------------------------------------------
        // 4. Notify connected clients
        // ---------------------------------------------------------------
        const signalsDir = getSignalsDir();
        mkdirSync(signalsDir, { recursive: true });
        writeFileSync(
          join(signalsDir, "emit-event"),
          JSON.stringify({ type: "platform_disconnected" }),
        );

        // ---------------------------------------------------------------
        // 5. Output result
        // ---------------------------------------------------------------
        writeOutput(cmd, {
          ok: true,
          disconnected: true,
          previousBaseUrl: baseUrl ?? null,
        });

        if (!jsonMode) {
          log.info(
            `Disconnected from platform${baseUrl ? ` at ${baseUrl}` : ""}`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeError(message);
      }
    });
}
