import fs from "node:fs";
import path from "node:path";

import { nanoid } from "nanoid";

import { guardianTokenPath } from "./config";
import {
  isConfidentialRefreshUrl,
  isLoopbackUrl,
  saveGuardianToken,
} from "./guardian-token";
import { readRawLockfile, upsertLockfileAssistant } from "./lockfile";

/**
 * A decoded `vellum pair` bundle: base64(JSON.stringify({ gatewayUrl, token,
 * ... })) printed on the host machine and imported on this one.
 */
export interface PairBundle {
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

export type DecodePairBundleResult =
  | { ok: true; bundle: PairBundle }
  | { ok: false; error: string };

/**
 * Decode and validate a base64 pairing bundle. Total and non-throwing:
 * malformed input yields a typed failure. `gatewayUrl` is persisted as
 * `runtimeUrl` and used to build fetch URLs, so it must be an absolute http(s)
 * URL rather than letting an invalid string through (which would crash
 * `new URL(...)` or break later client calls).
 */
export function decodePairBundle(encoded: string): DecodePairBundleResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return { ok: false, error: "Bundle is not base64-encoded JSON" };
  }
  if (typeof json !== "object" || json === null) {
    return { ok: false, error: "Bundle is not a JSON object" };
  }
  const b = json as Record<string, unknown>;
  if (typeof b.gatewayUrl !== "string" || typeof b.token !== "string") {
    return { ok: false, error: "Bundle is missing gatewayUrl or token" };
  }
  let parsed: URL;
  try {
    parsed = new URL(b.gatewayUrl);
  } catch {
    return { ok: false, error: "Bundle gatewayUrl is not an absolute URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Bundle gatewayUrl is not an http(s) URL" };
  }
  return {
    ok: true,
    bundle: {
      gatewayUrl: b.gatewayUrl,
      token: b.token,
      assistantId:
        typeof b.assistantId === "string" ? b.assistantId : undefined,
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
    },
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
      Buffer.from(parts[1]!, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    /* fall through */
  }
  return null;
}

export interface PairOptions {
  /** A bundle validated by {@link decodePairBundle}. */
  bundle: PairBundle;
  /** Optional local name; its slug becomes the entry's assistantId. */
  name?: string;
}

/**
 * Failure statuses: 400 the name slugifies to nothing, 409 the id names an
 * existing non-paired assistant (`assistantId` carries the refused id),
 * 422 the bundle's gatewayUrl is unparseable, 500 a write failed.
 */
export type PairResult =
  | {
      ok: true;
      /** The unique local id the pairing was registered under. */
      assistantId: string;
      /** True when an existing paired entry was updated in place. */
      updated: boolean;
      /** True when the bundle carried no refresh credential. */
      accessOnly: boolean;
    }
  | { ok: false; status: number; error: string; assistantId?: string };

/**
 * Register a pairing bundle on this machine: persist the guardian token and
 * upsert a `cloud: "paired"` lockfile entry, the write counterpart of
 * `unpairAssistant`.
 *
 * The entry is stored under a UNIQUE LOCAL id (not the bundle's assistantId,
 * which is typically "self" and would collide across hosts). This is safe
 * because the gateway's runtime proxy strips the `/v1/assistants/<id>/` segment
 * before forwarding, so the local id never has to match the remote one: the
 * token (validated by signature/audience) is what authorizes requests.
 */
export function pairAssistant(
  lockfilePaths: string[],
  configDir: string,
  { bundle, name }: PairOptions,
): PairResult {
  let gatewayHost: string;
  try {
    gatewayHost = new URL(bundle.gatewayUrl).host;
  } catch {
    return {
      ok: false,
      status: 422,
      error: "Bundle gatewayUrl is not an absolute URL",
    };
  }

  // A paired entry is remote by definition (`vellum pair` refuses to advertise
  // loopback URLs), and a loopback runtimeUrl in the lockfile would otherwise
  // read as a local gateway to loopback-port consumers. Refuse it outright so
  // a crafted bundle cannot point a pairing at this machine's own services.
  if (isLoopbackUrl(bundle.gatewayUrl)) {
    return {
      ok: false,
      status: 422,
      error:
        "A paired assistant needs a non-loopback gateway URL; run `vellum pair` " +
        "with --url pointing at a tunnel or LAN address.",
    };
  }

  // Unique local id: a name slug, or paired-<deviceId> (deviceId is unique per
  // pairing). Never the bundle's "self" assistantId, which would collide. The
  // deviceId comes from an untrusted bundle and is used as a path component by
  // saveGuardianToken, so it MUST be slugified (no `../` traversal); fall back
  // to a random id if it sanitizes to empty.
  const localId = name
    ? slugify(name)
    : `paired-${slugify(bundle.deviceId ?? "") || nanoid()}`;
  if (!localId) {
    return {
      ok: false,
      status: 400,
      error: "Name must contain at least one alphanumeric character",
    };
  }

  // Don't clobber an existing assistant. Only update in place when the prior
  // entry is itself a paired import (marked `paired: true`); otherwise the id
  // collides with a real local/remote assistant and overwriting would drop its
  // resources/runtime metadata. Reject and let the caller pick a fresh name.
  const rawAssistants = readRawLockfile(lockfilePaths).assistants;
  const existing = (
    Array.isArray(rawAssistants)
      ? (rawAssistants as Array<Record<string, unknown>>)
      : []
  ).find((a) => a?.assistantId === localId);
  if (existing && existing.paired !== true) {
    return {
      ok: false,
      status: 409,
      error: `An assistant named '${localId}' already exists`,
      assistantId: localId,
    };
  }

  // Write the token BEFORE committing the lockfile entry, the mirror of
  // unpair's ordering. A lockfile entry must never exist without its
  // credential (every read path would 404 on the token), while a token
  // without an entry is inert and overwritten by the next import. The prior
  // token contents are kept in memory so a failed lockfile write below can
  // roll the file back.
  const tokenPath = guardianTokenPath(configDir, localId);
  let priorToken: string | null;
  try {
    priorToken = fs.readFileSync(tokenPath, "utf-8");
  } catch {
    priorToken = null;
  }

  const now = Date.now();
  try {
    saveGuardianToken(configDir, localId, {
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
      pairedGatewayUrl: bundle.gatewayUrl,
    });
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: `Failed to write the guardian token: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const writeResult = upsertLockfileAssistant(
    lockfilePaths,
    {
      assistantId: localId,
      name: name ?? `paired (${gatewayHost})`,
      runtimeUrl: bundle.gatewayUrl,
      // Paired entries are reached by bearer token at the remote runtimeUrl
      // (a non-"vellum" cloud selects the bearer-token auth path in client.ts).
      // The "paired" topology lets lifecycle/status commands (ps/wake/sleep)
      // recognize this as a remote pairing rather than an on-machine process.
      cloud: "paired",
      // Marks this entry as a connect-import so re-imports update in place
      // while imports never silently overwrite a non-paired assistant (see
      // guard above).
      paired: true,
      species: "vellum",
    },
    undefined,
  );
  if (!writeResult.ok) {
    // The entry was not registered, so undo the token write (best-effort;
    // the write failure itself is what gets reported): restore the prior
    // token of a re-import, or delete the freshly written one.
    try {
      if (priorToken !== null) {
        fs.writeFileSync(tokenPath, priorToken, { mode: 0o600 });
      } else {
        fs.rmSync(tokenPath, { force: true });
        fs.rmdirSync(path.dirname(tokenPath));
      }
    } catch {
      // Rollback failed; the reported write error already covers the outcome.
    }
    return writeResult;
  }

  return {
    ok: true,
    assistantId: localId,
    updated: existing !== undefined,
    // A refresh token is only usable over a confidential channel; with
    // loopback refused above, a plaintext http gateway can never renew, so it
    // is reported access-only and gets the expiry warning.
    accessOnly:
      !bundle.refreshToken || !isConfidentialRefreshUrl(bundle.gatewayUrl),
  };
}

/**
 * Bounds what an untrusted connect-import request can make a host buffer and
 * decode. Enforced by {@link connectImport} for every host.
 */
export const MAX_PAIR_BUNDLE_LENGTH = 64 * 1024;

export interface ConnectImportOptions {
  /** The encoded bundle exactly as received from the transport. */
  bundle: unknown;
  /** Optional local name; non-string or empty values are ignored. */
  name?: unknown;
}

/**
 * Wire-shaped result of a connect-import: the success members are the response
 * body fields, and `status` on failure is the HTTP status the loopback hosts
 * respond with (the IPC host ignores it).
 */
export type ConnectImportResult =
  | { ok: true; assistantId: string; accessOnly: boolean }
  | { ok: false; status: number; error: string };

/**
 * The complete connect-import host operation: validate the raw bundle value
 * (present, non-empty, within {@link MAX_PAIR_BUNDLE_LENGTH}), decode it, and
 * register the pairing via {@link pairAssistant}. Hosts keep only
 * transport-specific parsing and pass the untrusted values straight through,
 * so bundle limits, error strings, and the result shape are defined once.
 */
export function connectImport(
  lockfilePaths: string[],
  configDir: string,
  { bundle, name }: ConnectImportOptions,
): ConnectImportResult {
  if (typeof bundle !== "string" || !bundle) {
    return { ok: false, status: 400, error: "Missing pairing bundle" };
  }
  if (bundle.length > MAX_PAIR_BUNDLE_LENGTH) {
    return { ok: false, status: 400, error: "Pairing bundle is too large" };
  }
  const decoded = decodePairBundle(bundle.trim());
  if (!decoded.ok) {
    return { ok: false, status: 400, error: decoded.error };
  }
  const result = pairAssistant(lockfilePaths, configDir, {
    bundle: decoded.bundle,
    name: typeof name === "string" && name ? name : undefined,
  });
  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error };
  }
  return {
    ok: true,
    assistantId: result.assistantId,
    accessOnly: result.accessOnly,
  };
}
