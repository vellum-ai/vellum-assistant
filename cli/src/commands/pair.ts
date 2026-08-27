/**
 * `vellum pair [assistant] [options]`
 *
 * Print the pairing link for another device, and the same link rendered as a
 * QR code. Runs on the machine hosting the assistant: it mints a remote-web
 * pairing challenge over the loopback gateway and approves it immediately, so
 * running this command IS the local-presence proof and one scan (or one paste
 * into `vellum connect import`) completes the pairing.
 *
 * `--web-approve` is the reverse direction: approve a code a device already
 * shows, for pairings that device started on its own.
 */

// Call `qrcodeTerminal.generate` as a method — the library reads its default
// error-correction level off `this`, so a destructured import renders nothing.
import qrcodeTerminal from "qrcode-terminal";

import {
  buildRemoteWebPairingUrl,
  resolvePublicBaseUrl,
  tunnelProviderWebsiteName,
  type PublicBaseUrlRejection,
  type RemoteWebPairingChallengeRequest,
  type RemoteWebPairingChallengeResponse,
  type RemoteWebPairingVerificationRequest,
  type RemoteWebPairingVerificationResponse,
} from "@vellumai/service-contracts/remote-web-pairing";

import { extractFlag } from "../lib/arg-utils.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import {
  formatAssistantLookupError,
  formatAssistantReference,
  lookupAssistantByIdentifier,
  resolveAssistant,
  type AssistantEntry,
} from "../lib/assistant-config.js";
import { GATEWAY_PORT } from "../lib/constants.js";
import { getCurrentEnvironment } from "../lib/environments/resolve.js";
import { isLoopbackUrl, loopbackSafeFetch } from "../lib/loopback-fetch.js";
import { formatWebApproveFailure, parseGatewayErrorCode } from "../lib/pair.js";
import { STALE_CLI_UPDATE_HINT } from "../lib/stale-cli-hint.js";

function assistantDisplayName(entry: AssistantEntry): string {
  return entry.name || entry.assistantName || entry.assistantId;
}

/**
 * The tunnel-recorded ingress URL from this entry's own lockfile record, when
 * usable as the pairing link's advertised address: https and non-loopback (the
 * bar a pairing URL must clear). The lockfile is the CLI-owned contract:
 * `vellum tunnel` providers mirror the URL onto the entry when they save it.
 */
function usableEntryIngressUrl(entry: AssistantEntry): string | null {
  const saved = entry.ingressUrl?.trim();
  if (!saved) {
    return null;
  }
  try {
    if (new URL(saved).protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }
  if (isLoopbackUrl(saved)) {
    return null;
  }
  return saved;
}

/**
 * Options this command used to have, and what replaced them. Named explicitly
 * so a scripted or copy-pasted invocation gets the migration instead of the
 * generic unknown-option error's out-of-date-CLI advice.
 */
const RETIRED_FLAGS = new Map<string, string>([
  [
    "--web",
    "the device being paired mints its own code. Run " +
      "`vellum connect import <assistant-url>` there, then approve the code " +
      "it prints with `vellum pair --web-approve <code>`.",
  ],
]);

function printUsage(): void {
  console.log(`vellum pair [beta] - Print a pairing link and QR code for another device

USAGE:
    vellum pair [assistant] [options]

Mints a pairing challenge on the assistant's gateway over loopback and
approves it on the spot (running this command on the host machine is the
approval), then prints the pairing link and the same link as a QR code.
Scanning the QR, opening the link, or passing it to 'vellum connect import'
on the other device completes the pairing in one step.

The link needs a public https address: --url, else the address 'vellum tunnel'
recorded for this assistant, else the assistant's runtime URL. Loopback,
private-network, plain-http, and tunnel-provider website addresses are refused
before anything is minted.

The challenge lives on the assistant's gateway and expires (10 minutes); the
link carries only a one-time device code, no tokens. Each paired device is
listed and separately revocable via 'vellum devices'.

ARGUMENTS:
    [assistant]     Assistant display name or ID (default: the active assistant)

OPTIONS:
    --url <url>     Public https base URL to advertise, e.g.
                    https://your-assistant.ts.net. Overrides the address saved
                    by 'vellum tunnel'.
    --label <name>  Name for this pairing. Shown in the output, and used as the
                    assistant's name in the --app link.
    --app           Encode the QR as a <scheme>://connect link that opens the
                    Vellum app directly. The https link is still printed as a
                    fallback for devices without the app.
    --app-scheme <scheme>
                    URL scheme for --app links; requires --app (default:
                    vellum-assistant; dev and staging app builds register
                    vellum-assistant-dev and vellum-assistant-staging).
    --web-approve <code>
                    Approve a pairing code another device is showing, in
                    ABCD-EFGH form, e.g. from 'vellum connect import <url>' or
                    the /assistant/pair page. Mints no link of its own.
    --json          Print JSON instead of the QR code:
                    {pairUrl, deviceCode, expiresAt, expiresInSeconds}, plus
                    appUrl with --app. With --web-approve, the approval
                    response: {status, verificationUri, expiresAt}.

EXAMPLES:
    vellum pair
    vellum pair "My Assistant" --url https://your-assistant.ts.net
    vellum pair --app --label "Phone"
    vellum pair --web-approve ABCD-EFGH
`);
}

/** Default URL scheme registered by production builds of the iOS app. */
const DEFAULT_APP_CONNECT_SCHEME = "vellum-assistant";

/**
 * Compose the custom-scheme link the iOS app's connect handler accepts:
 * `<scheme>://connect?url=<base>&code=<device code>[&name=<label>]`. The app
 * persists the base (and the label, when present) as its self-hosted server
 * and opens the pair page with the code.
 */
export function buildAppConnectUrl(
  scheme: string,
  baseUrl: string,
  deviceCode: string,
  name?: string,
): string {
  const params = new URLSearchParams({ url: baseUrl, code: deviceCode });
  if (name) {
    params.set("name", name);
  }
  // Percent-encode spaces: URLSearchParams form-encodes them as `+`, which
  // the app's Foundation URLComponents parser keeps as a literal plus.
  const query = params.toString().replace(/\+/g, "%20");
  return `${scheme}://connect?${query}`;
}

/**
 * POST a JSON body to a loopback gateway route, exiting with a clear message
 * when the gateway is unreachable. Non-2xx responses are returned to the
 * caller; use {@link gatewayPostOrExit} unless the call site prints its own
 * HTTP-error diagnostics.
 */
async function gatewayPost(
  gatewayUrl: string,
  path: string,
  body: unknown,
): Promise<Response> {
  try {
    return await loopbackSafeFetch(`${gatewayUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
}

/**
 * {@link gatewayPost}, but also exiting with a generic message on non-2xx.
 * Every pairing subcommand talks to the gateway this way, so the reachability
 * + HTTP-error handling has a single home.
 */
async function gatewayPostOrExit(
  gatewayUrl: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return exitOnHttpError(await gatewayPost(gatewayUrl, path, body));
}

/** Exit with a generic HTTP-error message on non-2xx; pass 2xx through. */
async function exitOnHttpError(response: Response): Promise<Response> {
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    console.error(
      `Error: HTTP ${response.status}: ${errorBody || response.statusText}`,
    );
    process.exit(1);
  }
  return response;
}

/** Create a remote-web pairing challenge (RFC 8628 device-code flow). */
async function createRemoteWebPairingChallenge(
  gatewayUrl: string,
  publicBaseUrl: string,
): Promise<RemoteWebPairingChallengeResponse> {
  const response = await gatewayPostOrExit(
    gatewayUrl,
    "/v1/remote-web/pairing-challenge",
    { publicBaseUrl } satisfies RemoteWebPairingChallengeRequest,
  );
  return (await response.json()) as RemoteWebPairingChallengeResponse;
}

/**
 * Approve a pending pairing challenge by its user code, the local-presence
 * proof for the device-code flow. Single owner of the pairing-verification
 * route and request body: the link flow approves via
 * {@link approveRemoteWebPairing} (generic exit on non-2xx), while
 * `--web-approve` calls this directly to inspect rejections and print mismatch
 * diagnostics (see {@link formatWebApproveFailure}).
 */
async function postPairingVerification(
  gatewayUrl: string,
  userCode: string,
): Promise<Response> {
  return gatewayPost(gatewayUrl, "/v1/remote-web/pairing-verification", {
    userCode,
  } satisfies RemoteWebPairingVerificationRequest);
}

/**
 * Approve the challenge this command just minted so one scan completes
 * pairing, exiting with a generic message on non-2xx.
 */
async function approveRemoteWebPairing(
  gatewayUrl: string,
  userCode: string,
): Promise<RemoteWebPairingVerificationResponse> {
  const response = await exitOnHttpError(
    await postPairingVerification(gatewayUrl, userCode),
  );
  return (await response.json()) as RemoteWebPairingVerificationResponse;
}

export async function pair(): Promise<void> {
  const rawArgs = process.argv.slice(3);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const retiredFlag = rawArgs.find((a) => RETIRED_FLAGS.has(a));
  if (retiredFlag) {
    console.error(
      `Error: ${retiredFlag} is no longer an option: ${RETIRED_FLAGS.get(retiredFlag)}`,
    );
    console.error("Run `vellum pair --help` to see available options.");
    process.exit(1);
  }

  const jsonOutput = rawArgs.includes("--json");
  const webApproval = rawArgs.includes("--web-approve");
  const appVariant = rawArgs.includes("--app");
  // `--qr` is accepted and ignored: QR output is unconditional, and iOS
  // Settings copy in the field names `vellum pair --qr`. Out of --help as a
  // compatibility shim, not part of the command's surface.
  let args = rawArgs.filter(
    (a) => a !== "--json" && a !== "--app" && a !== "--qr",
  );

  const [label, afterLabel] = extractFlag(args, "--label");
  const [webApproveCode, afterWebApprove] = extractFlag(
    afterLabel,
    "--web-approve",
  );
  const [urlOverride, afterUrl] = extractFlag(afterWebApprove, "--url");
  const [appSchemeOverride, afterAppScheme] = extractFlag(
    afterUrl,
    "--app-scheme",
  );
  args = afterAppScheme;

  // Any `--`-prefixed token left after known-flag extraction is an option this
  // CLI version doesn't support. Fail loud before any network call rather than
  // letting it fall through: an unknown flag would otherwise be silently
  // dropped and the command would run the wrong flow. Positional names never
  // start with `--`, so multi-word assistant targets are unaffected.
  const unknownFlag = args.find((a) => a.startsWith("--"));
  if (unknownFlag) {
    console.error(`Error: unknown option '${unknownFlag}'.`);
    console.error("Run `vellum pair --help` to see available options.");
    console.error(
      `If this option is from newer docs, ${STALE_CLI_UPDATE_HINT}`,
    );
    process.exit(1);
  }

  if (webApproval && !webApproveCode) {
    console.error("Error: --web-approve requires a pairing code.");
    process.exit(1);
  }
  if ((appVariant || appSchemeOverride) && webApproveCode) {
    console.error(
      "Error: --app and --app-scheme don't apply to --web-approve, which " +
        "approves a code the other device already has.",
    );
    process.exit(1);
  }
  // A scheme only names the app link, so accepting it without --app would
  // print the https QR and drop the scheme without saying so.
  if (appSchemeOverride && !appVariant) {
    console.error(
      "Error: --app-scheme names the scheme for the app link, so it needs " +
        "--app. Re-run with both, or drop --app-scheme for the https link.",
    );
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
  // advertise a REACHABLE url in the link, since the loopback url would point
  // the other device at its own localhost. Prefer an explicit --url, then the
  // ingress URL a tunnel provider saved, then the runtime (LAN/tunnel) url.
  const mintUrl = (
    entry.localUrl ||
    entry.runtimeUrl ||
    `http://127.0.0.1:${GATEWAY_PORT}`
  ).replace(/\/+$/, "");
  const savedIngressUrl =
    !urlOverride && !webApproveCode ? usableEntryIngressUrl(entry) : null;
  const advertisedUrl = (
    urlOverride ||
    savedIngressUrl ||
    entry.runtimeUrl ||
    mintUrl
  ).replace(/\/+$/, "");
  if (savedIngressUrl && !jsonOutput) {
    console.log(
      `Using saved ingress URL ${savedIngressUrl} ` +
        "(from vellum tunnel; override with --url).",
    );
  }

  if (webApproveCode) {
    // Rejections are diagnosed here rather than by exitOnHttpError: a
    // rejected code must name the gateway that was asked, or an
    // assistant/environment mismatch is indistinguishable from a typo.
    const response = await postPairingVerification(mintUrl, webApproveCode);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const diagnostic = formatWebApproveFailure(
        mintUrl,
        formatAssistantReference(entry),
        getCurrentEnvironment().name,
        parseGatewayErrorCode(errorBody),
      );
      console.error(
        diagnostic ??
          `Error: HTTP ${response.status}: ${errorBody || response.statusText}`,
      );
      process.exit(1);
    }
    const result =
      (await response.json()) as RemoteWebPairingVerificationResponse;
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log("Remote web pairing approved.");
    console.log(`Expires: ${result.expiresAt}`);
    return;
  }

  // Validate the public URL before any network call: a link that encodes a
  // loopback or plain-http address is unusable from another device.
  const resolved = resolvePublicBaseUrl(advertisedUrl);
  if (!resolved.ok) {
    const detailByReason: Record<PublicBaseUrlRejection, string> = {
      unparseable: `${advertisedUrl} isn't a valid URL`,
      loopback: `${advertisedUrl} is a loopback address`,
      "private-address": `${advertisedUrl} is a private-network address the other device can't reach`,
      "non-https": `${advertisedUrl} is not https`,
      "service-website": `${advertisedUrl} is ${
        tunnelProviderWebsiteName(advertisedUrl) ?? "a tunnel provider"
      }'s website, not your assistant's address`,
    };
    console.error(
      "Error: pairing needs a public https URL the other device can open: " +
        `${detailByReason[resolved.reason]}.`,
    );
    console.error(
      "Re-run with your assistant's public URL, e.g.:\n" +
        "  vellum pair --url https://your-assistant.ts.net",
    );
    console.error(
      "No public URL yet? Run `vellum tunnel --provider tailscale` first.",
    );
    process.exit(1);
  }
  const publicBaseUrl = resolved.url;

  // Mint a challenge and immediately approve it: running this CLI on the host
  // IS the local-presence proof, so the other device completes pairing in one
  // step from the link alone.
  const challenge = await createRemoteWebPairingChallenge(
    mintUrl,
    publicBaseUrl,
  );
  await approveRemoteWebPairing(mintUrl, challenge.userCode);
  const pairUrl = buildRemoteWebPairingUrl(challenge);
  const displayName = assistantDisplayName(entry);
  const appUrl = appVariant
    ? buildAppConnectUrl(
        appSchemeOverride ?? DEFAULT_APP_CONNECT_SCHEME,
        publicBaseUrl,
        challenge.deviceCode,
        label || displayName,
      )
    : null;

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          pairUrl,
          ...(appUrl ? { appUrl } : {}),
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

  console.log(
    label
      ? `Scan to pair "${label}" with ${displayName}:`
      : `Scan to pair a device with ${displayName}:`,
  );
  console.log("");
  qrcodeTerminal.generate(appUrl ?? pairUrl, { small: true }, (qr) => {
    console.log(qr);
  });
  console.log("");
  if (appUrl) {
    console.log("The QR opens the Vellum app. App link:");
    console.log("");
    console.log(`  ${appUrl}`);
    console.log("");
    console.log("No app on the device? Open this URL in its browser instead:");
  } else {
    console.log("Or open this URL on the device:");
  }
  console.log("");
  console.log(`  ${pairUrl}`);
  console.log("");
  console.log(`On another computer, run:  vellum connect import "${pairUrl}"`);
  console.log("");
  console.log(`Expires: ${challenge.expiresAt}`);
}
