import type { Command } from "commander";

import { getGatewayInternalBaseUrl } from "../../config/env.js";
import { loadRawConfig } from "../../config/loader.js";
import { asRecord, runRead } from "./utils.js";

function readIngressConfig(): {
  success: true;
  enabled: boolean;
  publicBaseUrl?: string;
  localGatewayTarget: string;
} {
  const raw = loadRawConfig();
  const ingress = asRecord(raw.ingress);
  const configuredUrl =
    typeof ingress.publicBaseUrl === "string"
      ? ingress.publicBaseUrl.trim()
      : "";
  const explicitEnabled =
    typeof ingress.enabled === "boolean" ? ingress.enabled : undefined;
  const enabled = explicitEnabled ?? configuredUrl.length > 0;

  return {
    success: true,
    enabled,
    publicBaseUrl: configuredUrl || undefined,
    localGatewayTarget: getGatewayInternalBaseUrl(),
  };
}

export function registerIngressSubcommand(integrations: Command): void {
  const ingress = integrations
    .command("ingress")
    .description("Trusted contact membership and invite status");

  ingress.addHelpText(
    "after",
    `
Shows the public ingress URL and local gateway target URL. Reads from the
local config file and does not require the gateway to be running.

Examples:
  $ assistant integrations ingress config`,
  );

  ingress
    .command("config")
    .description("Get public ingress URL and local gateway target")
    .addHelpText(
      "after",
      `
Shows the public ingress URL and the local gateway target URL. Reads from
the local config file and does not require the gateway to be running.

The response includes whether ingress is enabled, the configured public base
URL (if any), and the local gateway target address. Ingress is considered
enabled if explicitly set to true or if a publicBaseUrl is configured.

Examples:
  $ assistant integrations ingress config
  $ assistant integrations ingress config --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => readIngressConfig());
    });
}
