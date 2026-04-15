import type { Command } from "commander";

import { getAssistantDomain } from "../../config/env.js";
import { VellumPlatformClient } from "../../platform/client.js";
import { getCliLogger } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

const log = getCliLogger("domain");

export function registerDomainCommand(program: Command): void {
  const baseDomain = getAssistantDomain();
  const domain = program
    .command("domain")
    .description(
      `Register and manage this assistant's custom subdomain on ${baseDomain}`,
    )
    .option("--json", "Machine-readable compact JSON output");

  domain.addHelpText(
    "after",
    `
Each assistant can register its own subdomain (e.g. becky.${baseDomain})
for email and web presence. DNS is pre-configured via wildcard
records — no manual DNS changes needed.

Examples:
  $ assistant domain register becky
  $ assistant domain register --json
  $ assistant domain status`,
  );

  domain
    .command("register [subdomain]")
    .description(
      `Register a custom subdomain on ${baseDomain} for this assistant`,
    )
    .addHelpText(
      "after",
      `
Arguments:
  subdomain   The subdomain to register (e.g. "becky" → becky.${baseDomain}).
              If omitted, the platform derives it from the assistant's name.

Registers a subdomain at <subdomain>.${baseDomain}. DNS is pre-configured
via wildcard records — no manual DNS changes needed.

Examples:
  $ assistant domain register becky
  ✓ Registered becky.${baseDomain}

  $ assistant domain register
  ✓ Registered my-assistant.${baseDomain}

  $ assistant domain register cool-bot --json
  {"domain":"cool-bot.${baseDomain}","id":"...","status":"active","verified":true}`,
    )
    .action(
      async (subdomain: string | undefined, _opts: unknown, cmd: Command) => {
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

          const body: Record<string, string> = {};
          if (subdomain) {
            body.subdomain = subdomain;
          }

          const response = await client.fetch(
            `/v1/assistants/${client.platformAssistantId}/domains/`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
          );

          if (!response.ok) {
            const respBody = (await response
              .json()
              .catch(() => ({}))) as Record<string, unknown>;
            const detail =
              respBody.detail ??
              (Array.isArray(respBody.subdomain)
                ? respBody.subdomain[0]
                : undefined) ??
              `HTTP ${response.status}`;
            throw new Error(String(detail));
          }

          const data = (await response.json()) as {
            id: string;
            domain: string;
            status: string;
            verified: boolean;
            created_at: string;
          };

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, data);
          } else {
            log.info(`✓ Registered ${data.domain}`);
            if (!data.verified) {
              log.info(
                "  ⚠ Domain verification pending — this usually resolves within a few seconds.",
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

  domain
    .command("status")
    .description("Show this assistant's domain registration and health")
    .addHelpText(
      "after",
      `
Shows the domain currently registered for this assistant, including
verification status and DNS health.

Examples:
  $ assistant domain status
  Domain:   becky.${baseDomain}
  Status:   active
  Verified: yes
  Created:  2026-04-15

  $ assistant domain status --json
  {"domain":"becky.${baseDomain}","status":"active","verified":true,...}`,
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

        const response = await client.fetch(
          `/v1/assistants/${client.platformAssistantId}/domains/`,
        );

        if (!response.ok) {
          const respBody = (await response.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          const detail = respBody.detail ?? `HTTP ${response.status}`;
          throw new Error(String(detail));
        }

        const data = (await response.json()) as {
          results: {
            id: string;
            domain: string;
            status: string;
            verified: boolean;
            created_at: string;
          }[];
        };

        const domains = data.results ?? [];

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, data);
        } else if (domains.length === 0) {
          log.info(
            "No domain registered for this assistant. Run: assistant domain register [subdomain]",
          );
        } else {
          for (const d of domains) {
            log.info(`Domain:   ${d.domain}`);
            log.info(`Status:   ${d.status}`);
            log.info(`Verified: ${d.verified ? "yes" : "no"}`);
            log.info(`Created:  ${d.created_at.split("T")[0]}`);
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
}
