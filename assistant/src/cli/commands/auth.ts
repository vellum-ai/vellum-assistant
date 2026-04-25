import type { Command } from "commander";

import {
  getPlatformAssistantId,
  getPlatformBaseUrl,
  getPlatformOrganizationId,
  getPlatformUserId,
} from "../../config/env.js";
import { resolveManagedProxyContext } from "../../providers/managed-proxy/context.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage platform authentication and identity")
    .option("--json", "Machine-readable compact JSON output");

  auth.addHelpText(
    "after",
    `
The auth namespace manages the assistant's authentication state with the
Vellum platform. It provides commands to inspect identity and connection
status, helping diagnose configuration issues.

Examples:
  $ assistant auth info
  $ assistant auth info --json`,
  );

  // ---------------------------------------------------------------------------
  // info
  // ---------------------------------------------------------------------------

  auth
    .command("info")
    .description("Show platform identity and authentication status")
    .addHelpText(
      "after",
      `
Fields:
  platformUrl         The Vellum platform base URL this assistant connects to
  assistantId         This assistant's platform UUID
  organizationId      The organization this assistant belongs to (from PLATFORM_ORGANIZATION_ID)
  userId              The user who owns this assistant (from PLATFORM_USER_ID)
  authenticated       Whether all prerequisites for platform authentication are met
                      (platform URL and assistant API key both present)

When not authenticated, a message field provides guidance on next steps.

Examples:
  $ assistant auth info
  $ assistant auth info --json`,
    )
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const ctx = await resolveManagedProxyContext();

      const platformUrl = getPlatformBaseUrl();
      const assistantId = getPlatformAssistantId();
      const organizationId = getPlatformOrganizationId();
      const userId = getPlatformUserId();
      const authenticated = ctx.enabled;

      const result: Record<string, unknown> = {
        platformUrl: platformUrl || null,
        assistantId: assistantId || null,
        organizationId: organizationId || null,
        userId: userId || null,
        authenticated,
      };

      if (!authenticated) {
        result.message = !platformUrl
          ? "Platform URL not configured. Run assistant config set platform.baseUrl <url>"
          : "Assistant API key not found. Store one with: assistant keys set credential/vellum/assistant_api_key <key>";
      }

      writeOutput(cmd, result);

      if (!shouldOutputJson(cmd)) {
        log.info(`Platform URL:        ${platformUrl || "(not set)"}`);
        log.info(`Assistant ID:        ${assistantId || "(not set)"}`);
        log.info(`Organization ID:     ${organizationId || "(not set)"}`);
        log.info(`User ID:             ${userId || "(not set)"}`);
        log.info(`Authenticated:       ${authenticated ? "yes" : "no"}`);
        if (!authenticated && result.message) {
          log.info("");
          log.info(result.message as string);
        }
      }
    });
}
