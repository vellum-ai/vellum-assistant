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
// Call `qrcodeTerminal.generate` as a method — the library reads its default
// error-correction level off `this`, so a destructured import renders nothing.
import qrcodeTerminal from "qrcode-terminal";

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
import {
  formatFeatureFlagGateMessage,
  isAssistantFeatureFlagEnabled,
  WEB_REMOTE_INGRESS_FLAG,
} from "../lib/feature-flags.js";
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
    --web            Create a browser pairing URL for remote web access
    --web-approve <code>
                    Approve a browser pairing code shown by /assistant/pair
    --qr             Render a QR code that pairs a device in one scan. Mints a
                    remote-web pairing challenge and approves it locally, so the
                    scan alone completes pairing. Needs a public https URL
                    (--url, else the assistant's public ingress URL); refuses
                    loopback or non-https URLs.
    --json           Output the result as JSON. With --qr: {url, deviceCode,
                    expiresAt, expiresInSeconds}

EXAMPLES:
    vellum pair
    vellum pair "My Assistant" --label "phone"
    vellum pair --url https://abc123.ngrok.app
    vellum pair --web --url https://abc123.ngrok.app
    vellum pair --web-approve ABCD-EFGH
    vellum pair --qr --url https://your-assistant.ts.net
    vellum pair --qr --json
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

interface RemoteWebPairingChallengeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  expiresInSeconds: number;
}

interface RemoteWebPairingApprovalResponse {
  status: "approved";
  verificationUri: string;
  expiresAt: string;
}

function normalizePublicBaseUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  const parts = url.pathname.split("/").filter(Boolean);
  const assistantIndex = parts.indexOf("assistant");
  if (assistantIndex >= 0) {
    parts.splice(assistantIndex);
  }
  url.pathname = parts.length ? `/${parts.join("/")}` : "/";
  return url.toString().replace(/\/+$/, "");
}

function buildRemoteWebPairingUrl(
  challenge: RemoteWebPairingChallengeResponse,
): string {
  const url = new URL(challenge.verificationUri);
  url.hash = new URLSearchParams({
    device_code: challenge.deviceCode,
  }).toString();
  return url.toString();
}

/**
 * Normalize the advertised URL to the public https origin a scanning phone can
 * open, or return null when it isn't internet-reachable. Stricter than the
 * copy-paste bundle path's loopback guard: a QR that encodes a loopback or
 * plain-http link is unusable from another device, so both are refused.
 */
function resolveQrPublicBaseUrl(advertisedUrl: string): string | null {
  let normalized: string;
  try {
    normalized = normalizePublicBaseUrl(advertisedUrl);
  } catch {
    return null;
  }
  if (isLoopbackHost(normalized)) {
    return null;
  }
  if (new URL(normalized).protocol !== "https:") {
    return null;
  }
  return normalized;
}

/**
 * POST a JSON body to a loopback gateway route, exiting with a clear message
 * when the gateway is unreachable or answers non-2xx. Every pairing subcommand
 * talks to the gateway this way, so the reachability + HTTP-error handling has
 * a single home.
 */
async function gatewayPostOrExit(
  gatewayUrl: string,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  let response: Response;
  try {
    response = await loopbackSafeFetch(`${gatewayUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
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
    const errorBody = await response.text().catch(() => "");
    console.error(
      `Error: HTTP ${response.status}: ${errorBody || response.statusText}`,
    );
    process.exit(1);
  }

  return response;
}

/**
 * Create a remote-web pairing challenge (RFC 8628 device-code flow). Shared by
 * `--web` and `--qr`, which differ only in how they present the same result.
 */
async function createRemoteWebPairingChallenge(
  gatewayUrl: string,
  publicBaseUrl: string,
): Promise<RemoteWebPairingChallengeResponse> {
  const response = await gatewayPostOrExit(
    gatewayUrl,
    "/v1/remote-web/pairing-challenge",
    { publicBaseUrl },
  );
  return (await response.json()) as RemoteWebPairingChallengeResponse;
}

/**
 * Approve a pending pairing challenge by its user code — the local-presence
 * proof for the device-code flow. Shared by `--web-approve` and `--qr` (which
 * approves the challenge it just minted so one scan completes pairing).
 */
async function approveRemoteWebPairing(
  gatewayUrl: string,
  userCode: string,
): Promise<RemoteWebPairingApprovalResponse> {
  const response = await gatewayPostOrExit(
    gatewayUrl,
    "/v1/remote-web/pairing-verification",
    { userCode },
  );
  return (await response.json()) as RemoteWebPairingApprovalResponse;
}

async function assertWebRemoteIngressEnabled(
  assistantId: string,
  runtimeUrl: string,
): Promise<void> {
  let enabled: boolean;
  try {
    enabled = await isAssistantFeatureFlagEnabled(
      assistantId,
      WEB_REMOTE_INGRESS_FLAG,
      { runtimeUrl },
    );
  } catch (err) {
    console.error(
      `Error: could not verify the \`${WEB_REMOTE_INGRESS_FLAG}\` feature flag. Is the assistant running? Try \`vellum wake\` and retry. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
  }

  if (!enabled) {
    console.error(
      `Error: ${formatFeatureFlagGateMessage(WEB_REMOTE_INGRESS_FLAG)}`,
    );
    process.exit(1);
  }
}

export async function pair(): Promise<void> {
  const rawArgs = process.argv.slice(3);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const jsonOutput = rawArgs.includes("--json");
  const webPairing = rawArgs.includes("--web");
  const webApproval = rawArgs.includes("--web-approve");
  const qrPairing = rawArgs.includes("--qr");
  let args = rawArgs.filter(
    (a) => a !== "--json" && a !== "--web" && a !== "--qr",
  );

  const [label, afterLabel] = extractFlag(args, "--label");
  const [webApproveCode, afterWebApprove] = extractFlag(
    afterLabel,
    "--web-approve",
  );
  const [urlOverride, afterUrl] = extractFlag(afterWebApprove, "--url");
  args = afterUrl;

  if (webPairing && webApproveCode) {
    console.error("Error: use either --web or --web-approve, not both.");
    process.exit(1);
  }
  if (webApproval && !webApproveCode) {
    console.error("Error: --web-approve requires a pairing code.");
    process.exit(1);
  }
  if (qrPairing && (webPairing || webApproveCode)) {
    console.error("Error: --qr can't be combined with --web or --web-approve.");
    process.exit(1);
  }

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
  if (
    !urlOverride &&
    !webApproveCode &&
    !qrPairing &&
    isLoopbackHost(advertisedUrl)
  ) {
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

  if (webApproveCode) {
    await assertWebRemoteIngressEnabled(entry.assistantId, mintUrl);

    const result = await approveRemoteWebPairing(mintUrl, webApproveCode);
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log("Remote web pairing approved.");
    console.log(`Expires: ${result.expiresAt}`);
    return;
  }

  if (webPairing) {
    await assertWebRemoteIngressEnabled(entry.assistantId, mintUrl);

    let publicBaseUrl: string;
    try {
      publicBaseUrl = normalizePublicBaseUrl(advertisedUrl);
    } catch {
      console.error(`Error: invalid --url value '${advertisedUrl}'.`);
      process.exit(1);
    }

    const challenge = await createRemoteWebPairingChallenge(
      mintUrl,
      publicBaseUrl,
    );
    const pairUrl = buildRemoteWebPairingUrl(challenge);

    if (jsonOutput) {
      console.log(
        JSON.stringify(
          {
            pairUrl,
            userCode: challenge.userCode,
            verificationUri: challenge.verificationUri,
            expiresAt: challenge.expiresAt,
            expiresInSeconds: challenge.expiresInSeconds,
          },
          null,
          2,
        ),
      );
      return;
    }

    const displayName = entry.name || entry.assistantName || entry.assistantId;
    console.log(`Created remote web pairing for ${displayName}.`);
    console.log("");
    console.log("Open this URL in the browser:");
    console.log("");
    console.log(`  ${pairUrl}`);
    console.log("");
    console.log("Approve this pairing locally when you're ready:");
    console.log("");
    const approveTarget = assistantName
      ? `${JSON.stringify(assistantName)} `
      : "";
    console.log(`  Code: ${challenge.userCode}`);
    console.log(
      `  Run:  vellum pair ${approveTarget}--web-approve ${challenge.userCode}`,
    );
    console.log("");
    console.log(`Expires: ${challenge.expiresAt}`);
    return;
  }

  if (qrPairing) {
    // Validate the public URL before any network call — a QR that encodes a
    // loopback or plain-http link is unscannable from another device.
    const qrBaseUrl = resolveQrPublicBaseUrl(advertisedUrl);
    if (!qrBaseUrl) {
      console.error(
        "Error: --qr needs a public https URL the phone can open — " +
          `${advertisedUrl} is ${
            isLoopbackHost(advertisedUrl) ? "a loopback address" : "not https"
          }.`,
      );
      console.error(
        "Re-run with your assistant's public URL, e.g.:\n" +
          "  vellum pair --qr --url https://your-assistant.ts.net",
      );
      process.exit(1);
    }

    await assertWebRemoteIngressEnabled(entry.assistantId, mintUrl);

    // Mint a challenge and immediately approve it: running this CLI on the host
    // IS the local-presence proof, so the scanning device completes pairing in
    // one step. Reuses the `--web` + `--web-approve` code paths.
    const challenge = await createRemoteWebPairingChallenge(mintUrl, qrBaseUrl);
    await approveRemoteWebPairing(mintUrl, challenge.userCode);
    const pairUrl = buildRemoteWebPairingUrl(challenge);

    if (jsonOutput) {
      console.log(
        JSON.stringify(
          {
            url: pairUrl,
            deviceCode: challenge.deviceCode,
            expiresAt: challenge.expiresAt,
            expiresInSeconds: challenge.expiresInSeconds,
          },
          null,
          2,
        ),
      );
      return;
    }

    const displayName = entry.name || entry.assistantName || entry.assistantId;
    console.log(`Scan to pair a device with ${displayName}:`);
    console.log("");
    qrcodeTerminal.generate(pairUrl, { small: true }, (qr) => {
      console.log(qr);
    });
    console.log("");
    console.log("Or open this URL on the device:");
    console.log("");
    console.log(`  ${pairUrl}`);
    console.log("");
    console.log(`Expires: ${challenge.expiresAt}`);
    return;
  }

  // Fresh per-pairing device identity — each `vellum pair` is independently
  // revocable.
  const deviceId = nanoid();

  const response = await gatewayPostOrExit(
    mintUrl,
    "/v1/pair",
    { deviceId, platform: "cli" },
    getClientRegistrationHeaders(CLI_INTERFACE_ID),
  );

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
