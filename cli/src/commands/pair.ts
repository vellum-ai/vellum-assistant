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
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
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
import { getLocalLanIPv4 } from "../lib/local.js";
import { loopbackSafeFetch } from "../lib/loopback-fetch.js";

function isLoopbackHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host.startsWith("127.");
  } catch {
    return false;
  }
}

function printUsage(): void {
  console.log(`vellum pair [beta] - Mint a device-scoped token for another machine

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
  // Present on the device-bound path: a long-lived refresh credential the
  // imported client uses to renew its access token (ISO-8601 strings).
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  refreshAfter?: string;
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
  // assistant. Join positional tokens so multi-word display names work even
  // unquoted (e.g. `vellum pair My Assistant`).
  const assistantName = parseAssistantTargetArg(args);
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

  // A local hatch's runtimeUrl is itself loopback (http://localhost:<port>),
  // so without an explicit --url the bundle would point the other machine at
  // its own localhost. Refuse to advertise a loopback URL unless the user
  // explicitly passed one. (An explicit --url is trusted as-is.)
  if (!urlOverride && isLoopbackHost(advertisedUrl)) {
    const lan = getLocalLanIPv4();
    // Use THIS assistant's gateway port (not the global default) — second
    // local instances listen on a different port.
    let port = String(GATEWAY_PORT);
    try {
      port = new URL(mintUrl).port || port;
    } catch {
      /* keep default */
    }
    const suggestion = lan
      ? `http://${lan}:${port}`
      : `http://<this-machine-ip>:${port}`;
    console.error(
      "Error: this assistant has no reachable gateway URL — its address is " +
        `loopback (${advertisedUrl}), which the other machine can't connect to.`,
    );
    console.error(
      `Re-run with a reachable URL, e.g.:\n  vellum pair --url ${suggestion}`,
    );
    process.exit(1);
  }

  // Fresh per-pairing device identity — each `vellum pair` is independently
  // revocable.
  const deviceId = nanoid();

  let response: Response;
  try {
    response = await loopbackSafeFetch(`${mintUrl}/v1/pair`, {
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
    // Carry the refresh credential through when the gateway issued one, so the
    // imported client can renew without re-pairing. Omitted entirely for an
    // access-only (older gateway) response so the bundle stays clean.
    ...(result.refreshToken
      ? {
          refreshToken: result.refreshToken,
          refreshTokenExpiresAt: result.refreshTokenExpiresAt,
          refreshAfter: result.refreshAfter,
        }
      : {}),
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
