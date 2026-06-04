/**
 * `vellum pair [assistant] [--label <name>]`
 *
 * Mint a device-scoped token for another machine and print a pairing bundle.
 * Runs on the machine hosting the assistant: it calls the local gateway's
 * loopback-only `POST /v1/pair` (cli interface) with a freshly generated
 * deviceId, then prints the credentials to hand to a second device.
 *
 * Each invocation generates a NEW random deviceId, so each pairing is an
 * independent, separately-revocable device (see `vellum unpair`, forthcoming).
 */

import { nanoid } from "nanoid";

import { extractFlag } from "../lib/arg-utils.js";
import { resolveAssistant } from "../lib/assistant-config.js";
import {
  CLI_INTERFACE_ID,
  getClientRegistrationHeaders,
} from "../lib/client-identity.js";
import { GATEWAY_PORT } from "../lib/constants.js";

function printUsage(): void {
  console.log(`vellum pair - Mint a device-scoped token for another machine

USAGE:
    vellum pair [assistant] [options]

ARGUMENTS:
    [assistant]    Instance name (default: active assistant)

OPTIONS:
    --label <name>   Human label for this pairing (echoed in the output)
    --json           Output the raw bundle as JSON

EXAMPLES:
    vellum pair
    vellum pair my-assistant --label "phone"
    vellum pair --json
`);
}

interface PairResponse {
  token: string;
  expiresAt: string;
  guardianId: string;
  assistantId: string;
}

export async function pair(): Promise<void> {
  const rawArgs = process.argv.slice(3);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const jsonOutput = rawArgs.includes("--json");
  let args = rawArgs.filter((a) => a !== "--json");

  const [label, filteredArgs] = extractFlag(args, "--label");
  args = filteredArgs;

  const assistantName = args[0];
  const entry = resolveAssistant(assistantName);
  if (!entry) {
    console.error(
      assistantName
        ? `No assistant instance found with name '${assistantName}'.`
        : "No assistant instance found. Run `vellum hatch` first.",
    );
    process.exit(1);
  }

  const gatewayUrl = (
    entry.localUrl ||
    entry.runtimeUrl ||
    `http://127.0.0.1:${GATEWAY_PORT}`
  ).replace(/\/+$/, "");

  // Fresh per-pairing device identity — each `vellum pair` is independently
  // revocable.
  const deviceId = nanoid();

  let response: Response;
  try {
    response = await fetch(`${gatewayUrl}/v1/pair`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getClientRegistrationHeaders(CLI_INTERFACE_ID),
      },
      body: JSON.stringify({ deviceId, platform: "cli" }),
    });
  } catch (err) {
    console.error(
      `Error: could not reach the gateway at ${gatewayUrl} ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    );
    console.error("Is the assistant running? Try `vellum wake`.");
    process.exit(1);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(
      `Error: HTTP ${response.status}: ${body || response.statusText}`,
    );
    process.exit(1);
  }

  const result = (await response.json()) as PairResponse;

  // Single-line, copy-pasteable blob for the consume side (`vellum connect
  // import <blob>`, forthcoming).
  const bundle = {
    gatewayUrl,
    assistantId: result.assistantId,
    token: result.token,
    deviceId,
  };
  const blob = Buffer.from(JSON.stringify(bundle)).toString("base64");

  if (jsonOutput) {
    console.log(
      JSON.stringify({ ...bundle, expiresAt: result.expiresAt }, null, 2),
    );
    return;
  }

  const displayName = entry.name || entry.assistantName || entry.assistantId;
  console.log(`Paired ${label ? `"${label}" ` : ""}with ${displayName}.`);
  console.log("");
  console.log(`  Gateway:   ${gatewayUrl}`);
  console.log(`  Assistant: ${result.assistantId}`);
  console.log(`  Expires:   ${result.expiresAt}`);
  console.log("");
  console.log("Hand this to the other machine (keep it secret):");
  console.log("");
  console.log(`  ${blob}`);
  console.log("");
}
