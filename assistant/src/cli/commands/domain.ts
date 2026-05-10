import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { getCliLogger } from "../logger.js";
import { registerCommand } from "../lib/register-command.js";
import { shouldOutputJson, writeOutput } from "../output.js";

const log = getCliLogger("domain");

export function registerDomainCommand(program: Command): void {
  registerCommand(program, {
    name: "domain",
    transport: "ipc",
    description:
      "Register and manage this assistant's custom subdomain",
    build: (domain) => {
      domain.option("--json", "Machine-readable compact JSON output");

      domain.addHelpText(
        "after",
        `
Each assistant can register its own subdomain (e.g. velly.<your-domain>)
for email and web presence. DNS managed by the Vellum platform.

Examples:
  $ assistant domain register velly
  $ assistant domain register --json
  $ assistant domain status`,
      );

      domain
        .command("register [subdomain]")
        .description(
          "Register a custom subdomain on <your-domain> for this assistant",
        )
        .addHelpText(
          "after",
          `
Arguments:
  subdomain   The subdomain to register (e.g. "velly" → velly.<your-domain>).
              If omitted, the platform derives it from the assistant's name.

Registers a subdomain at <subdomain>.<your-domain>. DNS managed by the
Vellum platform — no manual DNS changes needed.

Examples:
  $ assistant domain register velly
  ✓ Registered velly.<your-domain>

  $ assistant domain register
  ✓ Registered my-assistant.<your-domain>

  $ assistant domain register velly --json
  {"domain":"velly.<your-domain>","id":"...","status":"active","verified":true}`,
        )
        .action(
          async (subdomain: string | undefined, _opts: unknown, cmd: Command) => {
            const r = await cliIpcCall<Record<string, unknown>>(
              "domain_register",
              { body: subdomain ? { subdomain } : {} },
            );

            if (!r.ok) {
              if (shouldOutputJson(cmd)) {
                writeOutput(cmd, { error: r.error });
              } else {
                log.error(`Error: ${r.error}`);
              }
              process.exitCode = 1;
              return;
            }

            const data = r.result ?? {};
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, data);
            } else {
              const displayDomain =
                (data.domain as string | undefined) ?? "unknown";
              log.info(`✓ Registered ${displayDomain}`);
              if (data.verified === false) {
                log.info(
                  "  ⚠ Domain verification pending — this usually resolves within a few seconds.",
                );
              }
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
  Domain:   velly.<your-domain>
  Status:   active
  Verified: yes
  Created:  2026-04-15

  $ assistant domain status --json
  {"domain":"velly.<your-domain>","status":"active","verified":true,...}`,
        )
        .action(async (_opts: unknown, cmd: Command) => {
          const r = await cliIpcCall<{
            results: {
              id: string;
              subdomain?: string;
              domain?: string;
              status?: string;
              verified?: boolean;
              created_at?: string;
              created?: string;
            }[];
          }>("domain_status");

          if (!r.ok) {
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, { error: r.error });
            } else {
              log.error(`Error: ${r.error}`);
            }
            process.exitCode = 1;
            return;
          }

          const data = r.result ?? { results: [] };
          const domains = data.results ?? [];

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, data);
          } else if (domains.length === 0) {
            log.info(
              "No domain registered for this assistant. Run: assistant domain register [subdomain]",
            );
          } else {
            for (const d of domains) {
              const displayDomain =
                d.domain ??
                (d.subdomain
                  ? `${d.subdomain}.<apex-domain>`
                  : "unknown");
              const createdRaw = d.created_at ?? d.created;
              const createdDate = createdRaw
                ? createdRaw.split("T")[0]
                : "unknown";
              log.info(`Domain:   ${displayDomain}`);
              if (d.status != null) log.info(`Status:   ${d.status}`);
              if (d.verified != null)
                log.info(`Verified: ${d.verified ? "yes" : "no"}`);
              log.info(`Created:  ${createdDate}`);
            }
          }
        });
    },
  });
}
