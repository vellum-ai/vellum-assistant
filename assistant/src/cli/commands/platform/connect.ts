import type { Command } from "commander";

import { credentialKey } from "../../../security/credential-key.js";
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
    .requiredOption(
      "--url <url>",
      "Platform base URL (e.g. https://api.vellum.ai)",
    )
    .requiredOption(
      "--api-key <key>",
      "Assistant API key for platform authentication",
    )
    .option("--assistant-id <id>", "Platform assistant ID")
    .addHelpText(
      "after",
      `
Stores platform credentials in the assistant's secure credential store and
validates the connection by calling the platform API.

When --assistant-id is not provided, the command attempts to look it up from
the platform using the supplied --url and --api-key.

Examples:
  $ assistant platform connect --url https://api.vellum.ai --api-key sk-abc123
  $ assistant platform connect --url https://api.vellum.ai --api-key sk-abc123 --assistant-id asst-xyz
  $ assistant platform connect --url https://api.vellum.ai --api-key sk-abc123 --json`,
    )
    .action(
      async (
        opts: {
          url: string;
          apiKey: string;
          assistantId?: string;
        },
        cmd: Command,
      ) => {
        const jsonMode = shouldOutputJson(cmd);

        const writeError = (error: string): void => {
          writeOutput(cmd, { ok: false, error });
          process.exitCode = 1;
        };

        try {
          const baseUrl = opts.url.replace(/\/+$/, "");

          // -----------------------------------------------------------------
          // 1. Validate the connection by calling the platform API
          // -----------------------------------------------------------------
          let assistantId = opts.assistantId?.trim() ?? "";
          let organizationId = "";
          let userId = "";

          try {
            const headers = new Headers();
            headers.set("Authorization", `Api-Key ${opts.apiKey}`);

            const response = await fetch(`${baseUrl}/v1/assistants/self/`, {
              headers,
            });

            if (!response.ok) {
              const errorText = await response.text().catch(() => "");
              writeError(
                `Platform validation failed — HTTP ${response.status}${errorText ? `: ${errorText}` : ""}. ` +
                  `Verify the --url and --api-key values are correct.`,
              );
              return;
            }

            const body = (await response.json()) as {
              id?: string;
              organization_id?: string;
              user_id?: string;
            };

            if (!assistantId && body.id) {
              assistantId = body.id;
            }
            if (body.organization_id) {
              organizationId = body.organization_id;
            }
            if (body.user_id) {
              userId = body.user_id;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            writeError(
              `Failed to reach platform at ${baseUrl}: ${message}. ` +
                `Verify the --url value is correct and the platform is reachable.`,
            );
            return;
          }

          // -----------------------------------------------------------------
          // 2. Check if already connected and warn
          // -----------------------------------------------------------------
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

          const wasConnected = !!existingUrl && !!existingApiKey;
          if (wasConnected && !jsonMode) {
            log.info("Overwriting existing platform connection credentials.");
          }

          // -----------------------------------------------------------------
          // 3. Store credentials
          // -----------------------------------------------------------------
          await setSecureKeyViaDaemon(
            "credential",
            `${CREDENTIAL_KEYS.baseUrl.service}:${CREDENTIAL_KEYS.baseUrl.field}`,
            baseUrl,
          );
          await setSecureKeyViaDaemon(
            "credential",
            `${CREDENTIAL_KEYS.apiKey.service}:${CREDENTIAL_KEYS.apiKey.field}`,
            opts.apiKey,
          );

          if (assistantId) {
            await setSecureKeyViaDaemon(
              "credential",
              `${CREDENTIAL_KEYS.assistantId.service}:${CREDENTIAL_KEYS.assistantId.field}`,
              assistantId,
            );
          }

          if (organizationId) {
            await setSecureKeyViaDaemon(
              "credential",
              `${CREDENTIAL_KEYS.organizationId.service}:${CREDENTIAL_KEYS.organizationId.field}`,
              organizationId,
            );
          }

          if (userId) {
            await setSecureKeyViaDaemon(
              "credential",
              `${CREDENTIAL_KEYS.userId.service}:${CREDENTIAL_KEYS.userId.field}`,
              userId,
            );
          }

          // -----------------------------------------------------------------
          // 4. Output result
          // -----------------------------------------------------------------
          const result: Record<string, unknown> = {
            ok: true,
            baseUrl,
            assistantId: assistantId || null,
            organizationId: organizationId || null,
            userId: userId || null,
            previouslyConnected: wasConnected,
          };

          writeOutput(cmd, result);

          if (!jsonMode) {
            log.info(`Connected to platform at ${baseUrl}`);
            if (assistantId) log.info(`  Assistant ID: ${assistantId}`);
            if (organizationId)
              log.info(`  Organization ID: ${organizationId}`);
            if (userId) log.info(`  User ID: ${userId}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(message);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Exported credential keys for use by status and disconnect commands
// ---------------------------------------------------------------------------

export { CREDENTIAL_KEYS };
