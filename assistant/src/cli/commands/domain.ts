import type { Command } from "commander";

import { getApexDomain, getAssistantDomain } from "../../config/env.js";
import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { getCliLogger } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

const log = getCliLogger("domain");

function handleDomainIpcError(
  r: { ok: false; error?: string; statusCode?: number },
  cmd: Command,
): void {
  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { error: r.error ?? "Unknown error" });
    process.exitCode = 1;
    return;
  }
  exitFromIpcResult(r);
}

export function registerDomainCommand(program: Command): void {
  const apexDomain = getApexDomain();
  const baseDomain = getAssistantDomain();
  registerCommand(program, {
    name: "domain",
    transport: "ipc",
    description: `Register and manage this assistant's custom subdomain on ${baseDomain}`,
    build: (domain) => {
      domain.option("--json", "Machine-readable compact JSON output");

      domain.addHelpText(
        "after",
        `
Each assistant can register its own subdomain (e.g. velly.${baseDomain})
for email and web presence. DNS managed by the Vellum platform.

Examples:
  $ assistant domain register velly
  $ assistant domain register velly --email-username hello
  $ assistant domain register --json
  $ assistant domain status`,
      );

      domain
        .command("register [subdomain]")
        .option(
          "--email-username <username>",
          "Also register an email address (e.g. --email-username hello → hello@<subdomain>.domain)",
        )
        .description(
          `Register a custom subdomain on ${baseDomain} for this assistant`,
        )
        .addHelpText(
          "after",
          `
Arguments:
  subdomain   The subdomain to register (e.g. "velly" → velly.${baseDomain}).
              If omitted, the platform derives it from the assistant's name.

Options:
  --email-username <username>  Also register an email address for the domain
                               (e.g. --email-username hello → hello@velly.${baseDomain})

Registers a subdomain at <subdomain>.${baseDomain}. DNS managed by the
Vellum platform — no manual DNS changes needed.

Examples:
  $ assistant domain register velly
  ✓ Registered velly.${baseDomain}

  $ assistant domain register velly --email-username hello
  ✓ Registered velly.${baseDomain} (email: hello@velly.${baseDomain})

  $ assistant domain register
  ✓ Registered my-assistant.${baseDomain}

  $ assistant domain register velly --json
  {"domain":"velly.${baseDomain}","id":"...","status":"active","verified":true}`,
        )
        .action(
          async (
            subdomain: string | undefined,
            opts: { emailUsername?: string },
            cmd: Command,
          ) => {
            const body: Record<string, string> = {};
            if (subdomain) {
              body.subdomain = subdomain;
            }
            if (opts.emailUsername) {
              body.email_username = opts.emailUsername;
            }

            const r = await cliIpcCall<{
              id: string;
              subdomain?: string;
              domain?: string;
              status?: string;
              verified?: boolean;
              created_at?: string;
              created?: string;
              email_error?: { detail: string; code: string };
            }>("domain_register", { body });

            if (!r.ok)
              return handleDomainIpcError(
                { ok: false, error: r.error, statusCode: r.statusCode },
                cmd,
              );

            const data = r.result!;
            const registeredSubdomain =
              data.subdomain ??
              data.domain?.replace(`.${apexDomain}`, "") ??
              subdomain;
            const displayDomain =
              data.domain ??
              (registeredSubdomain
                ? `${registeredSubdomain}.${apexDomain}`
                : "unknown");

            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, data);
            } else {
              if (opts.emailUsername && !data.email_error) {
                log.info(
                  `✓ Registered ${displayDomain} (email: ${opts.emailUsername}@${displayDomain})`,
                );
              } else {
                log.info(`✓ Registered ${displayDomain}`);
              }
              if (data.email_error) {
                log.warn(
                  `⚠ Email registration failed: ${data.email_error.detail}`,
                );
              }
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
  Domain:   velly.${baseDomain}
  Status:   active
  Verified: yes
  Created:  2026-04-15

  $ assistant domain status --json
  {"domain":"velly.${baseDomain}","status":"active","verified":true,...}`,
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

          if (!r.ok)
            return handleDomainIpcError(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );

          const data = r.result!;
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
                (d.subdomain ? `${d.subdomain}.${apexDomain}` : "unknown");
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
