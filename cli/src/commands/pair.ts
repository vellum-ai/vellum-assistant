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
import {
  formatAssistantLookupError,
  lookupAssistantByIdentifier,
  resolveAssistant,
  type AssistantEntry,
} from "../lib/assistant-config.js";
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
    --url <url>      Reachable gateway URL to advertise in the bundle
                    (default: the assistant's runtime URL, not loopback)
    --label <name>   Human label for this pairing (echoed in the output)
    --json           Output the raw bundle as JSON

EXAMPLES:
    vellum pair
    vellum pair "My Assistant" --label "phone"
    vellum pair --url https://abc123.ngrok.app
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

  const [label, afterLabel] = extractFlag(args, "--label");
  const [urlOverride, afterUrl] = extractFlag(afterLabel, "--url");
  args = afterUrl;

  // Resolve the target. An explicit argument is matched by display name OR id
  // (with the standard ambiguity error); no argument falls back to the active
  // assistant.
  const assistantName = args[0];
  let entry: AssistantEntry | null;
  if (assistantName) {
    const result = lookupAssistantByIdentifier(assistantName);
    if (result.status !== "found") {
      console.error(formatAssistantLookupError(assistantName, result));
      process.exit(1);
    }
    entry = result.entry;
  } else {
    entry = resolveAssistant();
    if (!entry) {
      console.error("No assistant instance found. Run `vellum hatch` first.");
      process.exit(1);
    }
  }

  // Mint over loopback (localUrl avoids mDNS for same-machine calls), but
  // advertise a REACHABLE url in the bundle — the loopback url would point the
  // other machine at its own localhost. Prefer an explicit --url, then the
  // runtime (LAN/tunnel) url.
  const mintUrl = (
    entry.localUrl ||
    entry.runtimeUrl ||
    `http://127.0.0.1:${GATEWAY_PORT}`
  ).replace(/\/+$/, "");
  const advertisedUrl = (urlOverride || entry.runtimeUrl || mintUrl).replace(
    /\/+$/,
    "",
  );

  // Fresh per-pairing device identity — each `vellum pair` is independently
  // revocable.
  const deviceId = nanoid();

  let response: Response;
  try {
    response = await fetch(`${mintUrl}/v1/pair`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getClientRegistrationHeaders(CLI_INTERFACE_ID),
      },
      body: JSON.stringify({ deviceId, platform: "cli" }),
    });
  } catch (err) {
    console.error(
      `Error: could not reach the gateway at ${mintUrl} ` +
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
    gatewayUrl: advertisedUrl,
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
  console.log(`  Gateway:   ${advertisedUrl}`);
  console.log(`  Assistant: ${result.assistantId}`);
  console.log(`  Expires:   ${result.expiresAt}`);
  console.log("");
  console.log("Hand this to the other machine (keep it secret):");
  console.log("");
  console.log(`  ${blob}`);
  console.log("");
}
