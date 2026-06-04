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
  return {
    gatewayUrl: b.gatewayUrl,
    token: b.token,
    assistantId: typeof b.assistantId === "string" ? b.assistantId : undefined,
    deviceId: typeof b.deviceId === "string" ? b.deviceId : undefined,
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

  const existed = findAssistantByName(localId) !== null;

  saveAssistantEntry({
    assistantId: localId,
    name: nameFlag ?? `paired (${new URL(bundle.gatewayUrl).host})`,
    runtimeUrl: bundle.gatewayUrl,
    // Tagged "local" for now because that selects the bearer-token auth path
    // in client.ts (vs the platform X-Session-Token path), which is what a
    // paired token needs. Caveat: lifecycle/status commands (`vellum ps`,
    // `vellum wake`) then treat the entry as an on-machine process.
    // TODO: introduce a distinct `cloud: "paired"` topology + lifecycle guards
    // so ps/wake don't try to manage a remote pairing as a local instance,
    // while keeping bearer auth. Tracked with the devices/unpair work.
    cloud: "local",
    species: "vellum",
  });

  const now = Date.now();
  saveGuardianToken(localId, {
    guardianPrincipalId: "imported",
    accessToken: bundle.token,
    accessTokenExpiresAt:
      jwtExpiryMs(bundle.token) ?? now + 24 * 60 * 60 * 1000,
    refreshToken: "",
    refreshTokenExpiresAt: 0,
    refreshAfter: "",
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
    "Note: the token is access-only and will expire — re-run `vellum pair` and import again when it does.",
  );
}
