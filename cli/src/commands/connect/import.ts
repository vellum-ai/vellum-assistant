/**
 * `vellum connect import <blob> [--name <localname>]`
 *
 * Import a pairing bundle printed by `vellum pair` on another machine and
 * register it locally so `vellum client`/`message`/`events <name>` work against
 * the remote assistant.
 *
 * The bundle is base64(JSON.stringify({ gatewayUrl, assistantId, token,
 * deviceId })). We store the entry under a UNIQUE LOCAL id (not the bundle's
 * assistantId, which is typically "self" and would collide across hosts). This
 * is safe because the gateway's runtime proxy strips the `/v1/assistants/<id>/`
 * segment before forwarding, so the local id never has to match the remote one
 * — the token (validated by signature/audience) is what authorizes requests.
 */

import { nanoid } from "nanoid";

import { extractFlag } from "../../lib/arg-utils.js";
import {
  findAssistantByName,
  saveAssistantEntry,
} from "../../lib/assistant-config.js";
import { saveGuardianToken } from "../../lib/guardian-token.js";

function printUsage(): void {
  console.log(`vellum connect import - Register an assistant paired from another machine

USAGE:
    vellum connect import <bundle> [options]

ARGUMENTS:
    <bundle>    The base64 bundle printed by 'vellum pair' on the host machine

OPTIONS:
    --name <name>   Local name to register the assistant under
                    (default: paired-<deviceId>)

EXAMPLES:
    vellum connect import eyJnYXRld2F5...
    vellum connect import eyJnYXRld2F5... --name desk
`);
}

interface PairBundle {
  gatewayUrl: string;
  token: string;
  assistantId?: string;
  deviceId?: string;
  // Optional refresh credential. Present when the host's gateway issued a
  // device-bound token pair; absent for older access-only bundles (which remain
  // importable, just without auto-renewal). `refreshTokenExpiresAt` mirrors
  // GuardianTokenData (ISO string OR epoch-ms number) so a numeric expiry isn't
  // silently dropped on import.
  refreshToken?: string;
  refreshTokenExpiresAt?: string | number;
  refreshAfter?: string;
}

/** Decode the base64 bundle, returning null if malformed or missing fields. */
function decodeBundle(blob: string): PairBundle | null {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(blob, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const b = json as Record<string, unknown>;
  if (typeof b.gatewayUrl !== "string" || typeof b.token !== "string") {
    return null;
  }
  // The gatewayUrl is persisted as runtimeUrl and used to build fetch URLs, so
  // require an absolute http(s) URL here rather than letting an invalid string
  // through (which would crash `new URL(...)` or break later client calls).
  try {
    const parsed = new URL(b.gatewayUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }
  return {
    gatewayUrl: b.gatewayUrl,
    token: b.token,
    assistantId: typeof b.assistantId === "string" ? b.assistantId : undefined,
    deviceId: typeof b.deviceId === "string" ? b.deviceId : undefined,
    refreshToken:
      typeof b.refreshToken === "string" ? b.refreshToken : undefined,
    refreshTokenExpiresAt:
      typeof b.refreshTokenExpiresAt === "string" ||
      typeof b.refreshTokenExpiresAt === "number"
        ? b.refreshTokenExpiresAt
        : undefined,
    refreshAfter:
      typeof b.refreshAfter === "string" ? b.refreshAfter : undefined,
  };
}

/** Lowercase, collapse non-alphanumerics to single dashes, trim dashes. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Best-effort JWT `exp` (epoch seconds) → epoch ms; null if undecodable. */
function jwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64").toString("utf8"),
    );
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    /* fall through */
  }
  return null;
}

export async function connectImport(): Promise<void> {
  const rawArgs = process.argv.slice(4);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const [nameFlag, args] = extractFlag(rawArgs, "--name");
  const blob = args[0];
  if (!blob) {
    console.error("Error: missing pairing bundle.");
    printUsage();
    process.exit(1);
  }

  const bundle = decodeBundle(blob);
  if (!bundle) {
    console.error(
      "Error: invalid pairing bundle. Paste the full base64 string printed by `vellum pair`.",
    );
    process.exit(1);
  }

  // Unique local id: a --name slug, or paired-<deviceId> (deviceId is unique
  // per pairing). Never the bundle's "self" assistantId — that would collide.
  // The deviceId comes from an untrusted bundle and is used as a path component
  // by saveGuardianToken, so it MUST be slugified (no `../` traversal); fall
  // back to a random id if it sanitizes to empty.
  const localId = nameFlag
    ? slugify(nameFlag)
    : `paired-${slugify(bundle.deviceId ?? "") || nanoid()}`;
  if (!localId) {
    console.error(
      "Error: --name must contain at least one alphanumeric character.",
    );
    process.exit(1);
  }

  // Don't clobber an existing assistant. Only update in place when the prior
  // entry is itself a paired import (marked `paired: true`); otherwise the id
  // collides with a real local/remote assistant and overwriting would drop its
  // resources/runtime metadata. Reject and let the user pick a fresh --name.
  const existing = findAssistantByName(localId);
  if (existing && existing.paired !== true) {
    console.error(
      `Error: an assistant named '${localId}' already exists locally. ` +
        "Choose a different --name to avoid overwriting it.",
    );
    process.exit(1);
  }
  const existed = existing !== null;

  saveAssistantEntry({
    assistantId: localId,
    name: nameFlag ?? `paired (${new URL(bundle.gatewayUrl).host})`,
    runtimeUrl: bundle.gatewayUrl,
    // Paired entries are reached by bearer token at the remote runtimeUrl
    // (a non-"vellum" cloud selects the bearer-token auth path in client.ts).
    // The "paired" topology lets lifecycle/status commands (ps/wake/sleep)
    // recognize this as a remote pairing rather than an on-machine process.
    cloud: "paired",
    // Marks this entry as a connect-import so re-imports update in place while
    // imports never silently overwrite a non-paired assistant (see guard above).
    paired: true,
    species: "vellum",
  });

  const now = Date.now();
  const hasRefresh = Boolean(bundle.refreshToken);
  saveGuardianToken(localId, {
    guardianPrincipalId: "imported",
    accessToken: bundle.token,
    accessTokenExpiresAt:
      jwtExpiryMs(bundle.token) ?? now + 24 * 60 * 60 * 1000,
    refreshToken: bundle.refreshToken ?? "",
    refreshTokenExpiresAt: bundle.refreshTokenExpiresAt ?? 0,
    refreshAfter: bundle.refreshAfter ?? "",
    isNew: false,
    deviceId: bundle.deviceId ?? "",
    leasedAt: new Date(now).toISOString(),
  });

  console.log(
    `${existed ? "Updated" : "Imported"} paired assistant '${localId}'.`,
  );
  console.log("");
  console.log(`  Connect with:  vellum client ${localId}`);
  console.log("");
  console.log(
    hasRefresh
      ? "Note: this connection includes a refresh credential, so it can renew itself — re-pair only if it's revoked or the refresh credential expires."
      : "Note: the token is access-only and will expire — re-run `vellum pair` and import again when it does.",
  );
}
