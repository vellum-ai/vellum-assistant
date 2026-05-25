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
  $ assistant domain status velly`,
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
  {"domain":"velly.${baseDomain}","id":"..."}`,
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
            }
          },
        );

      domain
        .command("status <subdomain>")
        .description(
          "Show registration and DNS verification status for a subdomain",
        )
        .addHelpText(
          "after",
          `
Arguments:
  subdomain   The subdomain to check (e.g. "velly").

Shows the domain's registration details and live DNS verification
status from the email provider.

Examples:
  $ assistant domain status velly
  Domain:       velly.${baseDomain}
  Verification: verified
                DNS records have been verified. Your domain is ready to send and receive email.
  Created:      2026-04-15

  $ assistant domain status velly --json
  {"domain":{"subdomain":"velly","id":"..."},"verification":{"status":"verified","message":"..."}}`,
        )
        .action(async (subdomain: string, _opts: unknown, cmd: Command) => {
          const r = await cliIpcCall<{
            results: {
              id: string;
              subdomain?: string;
              domain?: string;
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
          const d = domains.find(
            (entry) => entry.subdomain === subdomain,
          );

          if (!d) {
            if (shouldOutputJson(cmd)) {
              writeOutput(cmd, { error: `Domain "${subdomain}" not found` });
              process.exitCode = 1;
            } else {
              log.error(
                `Domain "${subdomain}" is not registered for this assistant.`,
              );
              process.exitCode = 1;
            }
            return;
          }

          // Fetch live verification status
          const v = await cliIpcCall<{
            domain: string;
            status: string;
            message: string;
          }>("domain_verification_status", {
            body: { domain_id: d.id },
          });

          const verification = v.ok ? v.result : undefined;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { domain: d, verification: verification ?? null });
          } else {
            const displayDomain =
              d.domain ??
              (d.subdomain ? `${d.subdomain}.${apexDomain}` : "unknown");
            const createdRaw = d.created_at ?? d.created;
            const createdDate = createdRaw
              ? createdRaw.split("T")[0]
              : "unknown";
            log.info(`Domain:       ${displayDomain}`);
            const vStatus = verification?.status ?? "unknown";
            log.info(`Verification: ${vStatus}`);
            if (verification?.message) {
              log.info(`              ${verification.message}`);
            }
            log.info(`Created:      ${createdDate}`);
          }
        });
    },
  });
}
