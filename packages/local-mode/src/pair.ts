import fs from "node:fs";
import path from "node:path";

import {
  parsePairingAddress,
  REMOTE_WEB_PAIRING_CODE_TTL_MS,
  resolveRemoteWebPairingPlatform,
  tunnelProviderWebsiteName,
  type PublicBaseUrlRejection,
  type RemoteWebPairingChallengeRequest,
  type RemoteWebPairingChallengeResponse,
  type RemoteWebPairingTokenPendingResponse,
  type RemoteWebPairingTokenRequest,
} from "@vellumai/service-contracts/remote-web-pairing";
import { nanoid } from "nanoid";

import { guardianTokenPath } from "./config";
import {
  isConfidentialRefreshUrl,
  isLoopbackUrl,
  saveGuardianToken,
} from "./guardian-token";
import { readRawLockfile, upsertLockfileAssistant } from "./lockfile";

/**
 * The session credentials a pairing exchange yields, in the shape
 * {@link pairAssistant} persists. `refreshToken` is absent when the assistant's
 * gateway does not issue a device-bound refresh credential, which imports the
 * pairing access-only.
 *
 * `refreshTokenExpiresAt` mirrors GuardianTokenData (ISO string OR epoch-ms
 * number) so a numeric expiry isn't silently dropped on import.
 */
export interface PairedAssistantCredentials {
  gatewayUrl: string;
  token: string;
  deviceId?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string | number;
  refreshAfter?: string;
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
  /** Credentials from a completed pairing exchange. */
  credentials: PairedAssistantCredentials;
  /** Optional local name; its slug becomes the entry's assistantId. */
  name?: string;
}

/**
 * Failure statuses: 400 the name slugifies to nothing, 409 the id names an
 * existing non-paired assistant (`assistantId` carries the refused id),
 * 422 the credentials' gatewayUrl is unusable, 500 a write failed.
 */
export type PairResult =
  | {
      ok: true;
      /** The unique local id the pairing was registered under. */
      assistantId: string;
      /** True when an existing paired entry was updated in place. */
      updated: boolean;
      /** True when the exchange yielded no usable refresh credential. */
      accessOnly: boolean;
    }
  | { ok: false; status: number; error: string; assistantId?: string };

/**
 * Register a pairing on this machine: persist the guardian token and upsert a
 * `cloud: "paired"` lockfile entry, the write counterpart of
 * `unpairAssistant`.
 *
 * The entry is stored under a UNIQUE LOCAL id (not the remote assistant id,
 * which is typically "self" and would collide across hosts). This is safe
 * because the gateway's runtime proxy strips the `/v1/assistants/<id>/` segment
 * before forwarding, so the local id never has to match the remote one: the
 * token (validated by signature/audience) is what authorizes requests.
 */
export function pairAssistant(
  lockfilePaths: string[],
  configDir: string,
  { credentials, name }: PairOptions,
): PairResult {
  let gatewayHost: string;
  try {
    gatewayHost = new URL(credentials.gatewayUrl).host;
  } catch {
    return {
      ok: false,
      status: 422,
      error: "Pairing gatewayUrl is not an absolute URL",
    };
  }

  // A paired entry is remote by definition (`vellum pair` refuses to advertise
  // loopback URLs), and a loopback runtimeUrl in the lockfile would otherwise
  // read as a local gateway to loopback-port consumers. Refuse it outright so
  // a crafted address cannot point a pairing at this machine's own services.
  if (isLoopbackUrl(credentials.gatewayUrl)) {
    return {
      ok: false,
      status: 422,
      error:
        "A paired assistant needs a non-loopback gateway URL; run `vellum pair` " +
        "with --url pointing at a tunnel or LAN address.",
    };
  }

  // Unique local id: a name slug, or paired-<deviceId> (deviceId is unique per
  // pairing). Never the remote "self" assistantId, which would collide. The
  // deviceId may be untrusted and is used as a path component by
  // saveGuardianToken, so it MUST be slugified (no `../` traversal); fall back
  // to a random id if it sanitizes to empty.
  const localId = name
    ? slugify(name)
    : `paired-${slugify(credentials.deviceId ?? "") || nanoid()}`;
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
      accessToken: credentials.token,
      accessTokenExpiresAt:
        jwtExpiryMs(credentials.token) ?? now + 24 * 60 * 60 * 1000,
      refreshToken: credentials.refreshToken ?? "",
      refreshTokenExpiresAt: credentials.refreshTokenExpiresAt ?? 0,
      refreshAfter: credentials.refreshAfter ?? "",
      isNew: false,
      deviceId: credentials.deviceId ?? "",
      leasedAt: new Date(now).toISOString(),
      pairedGatewayUrl: credentials.gatewayUrl,
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
      runtimeUrl: credentials.gatewayUrl,
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
      !credentials.refreshToken ||
      !isConfidentialRefreshUrl(credentials.gatewayUrl),
  };
}

// ── Host-side pairing sessions ──────────────────────────────────────────────
//
// A pairing address is either a full pairing link (it carries an approved
// device code) or a bare assistant URL (this machine mints its own challenge
// and the user approves the printed code on the host). Both end at one
// `POST /v1/remote-web/pairing-token` exchange whose credentials go straight
// to `pairAssistant`.
//
// The device code, the generated device id, and the minted tokens never leave
// this process: callers hold an opaque handle and see only the approval code
// they are meant to display.

/**
 * Bounds what an untrusted pairing request can make a host buffer and parse.
 * A pairing link is a URL, so anything approaching this is not one.
 */
const MAX_PAIRING_ADDRESS_LENGTH = 2 * 1024;

/** Poll cadence used until the gateway names its own. */
const DEFAULT_PAIRING_POLL_INTERVAL_SECONDS = 5;

/** Caps how long a single pairing request may occupy the caller. */
const PAIRING_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Caps how many bytes of a pairing reply a host will buffer. Every pairing
 * response is a small fixed-shape payload, so a body approaching this is not
 * one and is refused rather than parsed.
 */
const MAX_PAIRING_RESPONSE_BYTES = 64 * 1024;

const PAIRING_CHALLENGE_PATH = "/v1/remote-web/pairing-challenge";
const PAIRING_TOKEN_PATH = "/v1/remote-web/pairing-token";

/** What a pairing attempt failed on, for callers picking recovery copy. */
export type PairingFailureReason =
  /** The pasted address is not a usable assistant address. */
  | "invalid-address"
  /** No live session for this handle: it was cancelled or never existed. */
  | "unknown-session"
  /** The device code expired, was denied, or was already spent. */
  | "expired"
  /** The assistant could not be reached. */
  | "unreachable"
  /** The assistant answered, but not with a pairing response. */
  | "gateway"
  /** The credentials arrived, but registering them locally was refused. */
  | "import";

export interface PairingFailure {
  ok: false;
  reason: PairingFailureReason;
  /** Ready to display. */
  error: string;
  /** HTTP status for the loopback hosts that expose this over a route. */
  status: number;
  /** Why the address was refused; set only for `invalid-address`. */
  rejection?: PublicBaseUrlRejection;
}

export interface PairingStarted {
  ok: true;
  /** Opaque key for {@link pairingPoll} and {@link pairingCancel}. */
  handle: string;
  /**
   * The approval code to display, or null when the address already carried an
   * approved device code and the first poll imports outright.
   */
  userCode: string | null;
  /** ISO-8601 instant the attempt expires. */
  expiresAt: string;
  /** Seconds to wait between {@link pairingPoll} calls. */
  intervalSeconds: number;
}

export type PairingStartResult = PairingStarted | PairingFailure;

export type PairingPollResult =
  | {
      ok: true;
      status: "pending";
      /** ISO-8601 instant the attempt expires. */
      expiresAt: string;
      /** Seconds to wait before polling again. */
      intervalSeconds: number;
    }
  | {
      ok: true;
      status: "imported";
      /** The unique local id the pairing was registered under. */
      assistantId: string;
      /** True when an existing paired entry was updated in place. */
      updated: boolean;
      /** True when the exchange yielded no usable refresh credential. */
      accessOnly: boolean;
    }
  | PairingFailure;

interface PendingPairing {
  publicBaseUrl: string;
  deviceCode: string;
  deviceId: string;
  expiresAtMs: number;
  intervalSeconds: number;
  /**
   * Aborted by {@link pairingCancel}: it stops the exchange in flight and
   * marks the session as one the caller walked away from. {@link pairingPoll}
   * reads this signal rather than the map so a cancel is distinguishable from
   * an entry the expiry sweep happened to drop mid-request.
   */
  abort: AbortController;
}

const pendingPairings = new Map<string, PendingPairing>();

/** Drop sessions past their challenge's TTL so the map can't grow unbounded. */
function sweepExpiredPairings(): void {
  const now = Date.now();
  for (const [handle, session] of pendingPairings) {
    if (now >= session.expiresAtMs) {
      pendingPairings.delete(handle);
    }
  }
}

function addressRejectionMessage(
  reason: PublicBaseUrlRejection,
  address: string,
): string {
  switch (reason) {
    case "loopback":
      return "That address points back at this machine. Use the assistant's public https address.";
    case "private-address":
      return "That address points at a private network address. Pairing needs the assistant's public address.";
    case "non-https":
      return "A pairing address must use https.";
    case "service-website":
      return `That is ${
        tunnelProviderWebsiteName(address) ?? "the tunnel provider"
      }'s own website, not your assistant's address.`;
    default:
      return "That is not a valid address. Paste the assistant's https URL or a pairing link.";
  }
}

function invalidAddress(
  error: string,
  rejection?: PublicBaseUrlRejection,
): PairingFailure {
  return {
    ok: false,
    reason: "invalid-address",
    status: 400,
    error,
    rejection,
  };
}

/**
 * No live session behind a handle: never opened, already settled, or
 * cancelled. A cancel that lands mid-exchange answers with this too, since
 * from the caller's side the outcome is the same: the attempt is over and a
 * retry needs a fresh code. Never retryable, so a caller cannot spin against
 * a session it just killed.
 */
function unknownSession(): PairingFailure {
  return {
    ok: false,
    reason: "unknown-session",
    status: 404,
    error: "That pairing attempt is no longer active. Start over.",
  };
}

function expiredCode(): PairingFailure {
  return {
    ok: false,
    reason: "expired",
    status: 410,
    error:
      "The pairing code expired or was denied. Start over to get a new one.",
  };
}

function unreachableAssistant(): PairingFailure {
  return {
    ok: false,
    reason: "unreachable",
    status: 503,
    error:
      "Could not reach that assistant. Check the address and that it is online.",
  };
}

function oversizedGatewayReply(): PairingFailure {
  return {
    ok: false,
    reason: "gateway",
    status: 502,
    error: "The assistant's pairing reply was too large to be read.",
  };
}

function unusableGatewayCredentials(): PairingFailure {
  return {
    ok: false,
    reason: "gateway",
    status: 502,
    error:
      "The assistant approved the pairing but returned credentials this device cannot use.",
  };
}

function unexpectedGatewayReply(status: number): PairingFailure {
  return {
    ok: false,
    reason: "gateway",
    status: 502,
    error: `The assistant's pairing reply could not be used (HTTP ${status}).`,
  };
}

type PairingPost =
  | { ok: true; status: number; body: unknown }
  | { ok: false; failure: PairingFailure };

type PairingBody =
  | { ok: true; value: unknown }
  | { ok: false; failure: PairingFailure };

/**
 * The reply body as JSON, read under {@link MAX_PAIRING_RESPONSE_BYTES}. An
 * over-cap body is refused mid-stream (the rest is never buffered) and a body
 * that is absent or not JSON reads as `null`, which every caller already
 * treats as an unusable reply.
 */
async function readPairingBody(response: Response): Promise<PairingBody> {
  const stream = response.body;
  if (!stream) {
    return { ok: true, value: null };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_PAIRING_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, failure: oversizedGatewayReply() };
      }
      chunks.push(value);
    }
  } catch {
    // A stream that errors or times out mid-body is a transport failure.
    await reader.cancel().catch(() => {});
    return { ok: false, failure: unreachableAssistant() };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    };
  } catch {
    return { ok: true, value: null };
  }
}

/**
 * One timeout-bounded pairing POST. A network error, a timeout, an over-cap
 * body, and a non-JSON body all resolve rather than throw so every caller
 * stays total.
 *
 * `redirect: "error"` is what keeps the address checks meaningful: a followed
 * 3xx would carry the request to a host `parsePairingAddress` never saw, so a
 * loopback or plaintext target could be reached through a validated public
 * URL. A pairing endpoint has no reason to redirect, and fetch rejects the
 * attempt as a transport failure.
 *
 * `cancelSignal` cuts a request short when its session is cancelled. An abort
 * reads as a transport failure here, so the caller that owns the signal has to
 * report the cancellation itself rather than passing this failure on.
 */
async function postPairingRequest(
  publicBaseUrl: string,
  routePath: string,
  body: unknown,
  cancelSignal?: AbortSignal,
): Promise<PairingPost> {
  const timeout = AbortSignal.timeout(PAIRING_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${publicBaseUrl}${routePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: cancelSignal ? AbortSignal.any([timeout, cancelSignal]) : timeout,
    });
  } catch {
    return { ok: false, failure: unreachableAssistant() };
  }
  const parsed = await readPairingBody(response);
  if (!parsed.ok) {
    return { ok: false, failure: parsed.failure };
  }
  return { ok: true, status: response.status, body: parsed.value };
}

function isChallengeResponse(
  value: unknown,
): value is RemoteWebPairingChallengeResponse {
  const payload = value as Partial<RemoteWebPairingChallengeResponse> | null;
  return (
    typeof payload?.deviceCode === "string" &&
    typeof payload.userCode === "string" &&
    typeof payload.expiresAt === "string"
  );
}

/** The credential fields a usable approved pairing reply carries. */
interface ApprovedCredentials {
  accessToken: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string | number;
  refreshAfter?: string;
}

/**
 * The credentials of an approved reply, or null when it is not one this device
 * can persist. Every field is checked before anything reaches the guardian
 * token file: an empty `accessToken` or a wrong-typed refresh field would
 * otherwise be written as a credential that reports success now and fails
 * later, at first use or first refresh.
 *
 * ABSENT refresh fields are legitimate. That is the older-gateway path, which
 * mints no device-bound refresh credential, and it imports access-only. A
 * field that is PRESENT with the wrong type is malformed rather than dropped,
 * so a broken reply is reported instead of silently degrading the pairing.
 *
 * The refresh CREDENTIAL is all-or-none. `refreshToken` and its expiry are the
 * device-bound pair, and half of it persists a zero expiry while reporting the
 * pairing as renewable, so the connection claims it can renew and then cannot.
 * `refreshAfter` is not part of that pair: every approved reply carries it,
 * including the browser and older-gateway ones that mint no refresh token.
 */
function approvedCredentials(value: unknown): ApprovedCredentials | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const {
    status,
    accessToken,
    refreshToken,
    refreshTokenExpiresAt,
    refreshAfter,
  } = value as Record<string, unknown>;
  if (status !== "approved") {
    return null;
  }
  if (typeof accessToken !== "string" || !accessToken) {
    return null;
  }
  if (refreshAfter !== undefined && typeof refreshAfter !== "string") {
    return null;
  }
  if (refreshToken === undefined || refreshToken === "") {
    // No refresh credential: the older-gateway path, imported access-only. A
    // stray expiry without a token would persist as a renewable-looking
    // credential, so it is malformed rather than dropped.
    if (refreshTokenExpiresAt !== undefined) {
      return null;
    }
    return { accessToken, refreshAfter };
  }
  if (typeof refreshToken !== "string") {
    return null;
  }
  if (!usableRefreshExpiry(refreshTokenExpiresAt)) {
    return null;
  }
  return { accessToken, refreshToken, refreshTokenExpiresAt, refreshAfter };
}

/**
 * A refresh expiry this device can act on: an ISO instant on the wire, or an
 * epoch-ms number, which PairedAssistantCredentials persists either of rather
 * than dropping one. Zero and negative values are already-expired sentinels.
 */
function usableRefreshExpiry(value: unknown): value is string | number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0;
  }
  if (typeof value !== "string") {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0;
}

/** An ISO instant as epoch ms, or `fallback` when it isn't one. */
function instantMs(value: unknown, fallback: number): number {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

function openPairingSession(
  session: Omit<PendingPairing, "abort">,
  userCode: string | null,
): PairingStarted {
  const handle = nanoid();
  pendingPairings.set(handle, { ...session, abort: new AbortController() });
  return {
    ok: true,
    handle,
    userCode,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    intervalSeconds: session.intervalSeconds,
  };
}

/**
 * Begin pairing with an assistant at `address`, either a pairing link or a
 * bare `https://host` URL. A link carries an approved device code, so the
 * first {@link pairingPoll} imports outright; a bare URL mints a challenge
 * whose `userCode` the caller displays for approval on the host.
 *
 * SSRF containment rides on `parsePairingAddress`, which refuses loopback,
 * private-network IP literals, non-https, and tunnel-vendor websites before
 * any request is made, and on {@link postPairingRequest} refusing to follow
 * redirects away from the address that was checked.
 */
export async function pairingStart(
  address: unknown,
): Promise<PairingStartResult> {
  if (typeof address !== "string" || !address.trim()) {
    return invalidAddress("Enter the assistant's address or a pairing link.");
  }
  if (address.length > MAX_PAIRING_ADDRESS_LENGTH) {
    return invalidAddress("That pairing address is too long.");
  }
  const trimmed = address.trim();
  const parsed = parsePairingAddress(trimmed);
  if (!parsed.ok) {
    return invalidAddress(
      addressRejectionMessage(parsed.reason, trimmed),
      parsed.reason,
    );
  }

  sweepExpiredPairings();
  const deviceId = nanoid();

  if (parsed.deviceCode) {
    return openPairingSession(
      {
        publicBaseUrl: parsed.publicBaseUrl,
        deviceCode: parsed.deviceCode,
        deviceId,
        // A link carries no expiry, so bound the session by the TTL the
        // gateway would have minted the challenge with.
        expiresAtMs: Date.now() + REMOTE_WEB_PAIRING_CODE_TTL_MS,
        intervalSeconds: DEFAULT_PAIRING_POLL_INTERVAL_SECONDS,
      },
      null,
    );
  }

  const posted = await postPairingRequest(
    parsed.publicBaseUrl,
    PAIRING_CHALLENGE_PATH,
    {
      publicBaseUrl: parsed.publicBaseUrl,
    } satisfies RemoteWebPairingChallengeRequest,
  );
  if (!posted.ok) {
    return posted.failure;
  }
  if (posted.status !== 200 || !isChallengeResponse(posted.body)) {
    return unexpectedGatewayReply(posted.status);
  }

  const challenge = posted.body;
  return openPairingSession(
    {
      publicBaseUrl: parsed.publicBaseUrl,
      deviceCode: challenge.deviceCode,
      deviceId,
      expiresAtMs: instantMs(
        challenge.expiresAt,
        Date.now() + REMOTE_WEB_PAIRING_CODE_TTL_MS,
      ),
      intervalSeconds: positiveSeconds(
        challenge.intervalSeconds,
        DEFAULT_PAIRING_POLL_INTERVAL_SECONDS,
      ),
    },
    challenge.userCode,
  );
}

export interface PairingPollOptions {
  /** The handle {@link pairingStart} returned. */
  handle: unknown;
  /** Optional local name; non-string or empty values are ignored. */
  name?: unknown;
  /** Platform to record for this device; defaults to `desktop`. */
  platform?: unknown;
}

/**
 * One device-code exchange attempt for a live session. Still-pending
 * challenges resolve with the cadence to wait before trying again; an approved
 * one is registered through {@link pairAssistant} in the same call.
 *
 * A {@link pairingCancel} that lands while the exchange is in flight ends the
 * attempt with nothing persisted, so a dismissed dialog or an interrupted CLI
 * never leaves credentials for an assistant the user declined to pair.
 */
export async function pairingPoll(
  lockfilePaths: string[],
  configDir: string,
  { handle, name, platform }: PairingPollOptions,
): Promise<PairingPollResult> {
  const key = typeof handle === "string" ? handle : "";
  const session = pendingPairings.get(key);
  if (!session) {
    return unknownSession();
  }
  if (Date.now() >= session.expiresAtMs) {
    pendingPairings.delete(key);
    return expiredCode();
  }

  const posted = await postPairingRequest(
    session.publicBaseUrl,
    PAIRING_TOKEN_PATH,
    {
      deviceCode: session.deviceCode,
      deviceId: session.deviceId,
      platform: resolveRemoteWebPairingPlatform(platform),
    } satisfies RemoteWebPairingTokenRequest,
    session.abort.signal,
  );
  // A cancel that lands while the gateway is answering: the caller closed the
  // dialog or interrupted the CLI, so the attempt is over and NOTHING is
  // persisted. This is the only guard the import needs, because no await sits
  // between here and `pairAssistant` below. It also outranks the transport
  // failure an aborted request produces, which would otherwise read as the
  // retryable `unreachable`.
  //
  // Residual: a cancel landing after the gateway recorded the device leaves
  // the code spent and a device credential registered gateway-side with
  // nothing local behind it. That row is visible and revocable in the host's
  // paired-devices list, which is where it belongs; keeping nothing locally is
  // what the user asked for.
  if (session.abort.signal.aborted) {
    return unknownSession();
  }
  // The session survives a transport failure so the caller can simply poll
  // again; the device code is untouched until the gateway answers.
  if (!posted.ok) {
    return posted.failure;
  }

  if (posted.status === 202) {
    const pending =
      posted.body as Partial<RemoteWebPairingTokenPendingResponse> | null;
    session.expiresAtMs = instantMs(pending?.expiresAt, session.expiresAtMs);
    session.intervalSeconds = positiveSeconds(
      pending?.intervalSeconds,
      session.intervalSeconds,
    );
    return {
      ok: true,
      status: "pending",
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      intervalSeconds: session.intervalSeconds,
    };
  }

  // The gateway answers an unknown, expired, denied, or already-spent device
  // code alike: the attempt is over and needs a fresh code.
  if (posted.status === 401 || posted.status === 404 || posted.status === 410) {
    pendingPairings.delete(key);
    return expiredCode();
  }
  // Anything else left the code exchangeable (the gateway releases it on a
  // repairable failure), so the session stays pollable.
  if (posted.status !== 200) {
    return unexpectedGatewayReply(posted.status);
  }

  // Past here the gateway has spent the code, so the session goes whether or
  // not the reply is usable and whether or not the local write succeeds; a
  // retry starts from a fresh code.
  pendingPairings.delete(key);
  const approved = approvedCredentials(posted.body);
  if (!approved) {
    return unusableGatewayCredentials();
  }

  const result = pairAssistant(lockfilePaths, configDir, {
    credentials: {
      gatewayUrl: session.publicBaseUrl,
      token: approved.accessToken,
      deviceId: session.deviceId,
      refreshToken: approved.refreshToken,
      refreshTokenExpiresAt: approved.refreshTokenExpiresAt,
      refreshAfter: approved.refreshAfter,
    },
    name: typeof name === "string" && name ? name : undefined,
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: "import",
      status: result.status,
      error: result.error,
    };
  }
  return {
    ok: true,
    status: "imported",
    assistantId: result.assistantId,
    updated: result.updated,
    accessOnly: result.accessOnly,
  };
}

/**
 * Forget a pending pairing. True when a live session was dropped.
 *
 * Aborting the session also cuts short an exchange already in flight, so a
 * cancel that beats the gateway's reply can leave the device code unspent, and
 * one that does not still stops {@link pairingPoll} short of persisting
 * anything.
 */
export function pairingCancel(handle: unknown): boolean {
  let dropped = false;
  if (typeof handle === "string") {
    const session = pendingPairings.get(handle);
    if (session) {
      pendingPairings.delete(handle);
      session.abort.abort();
      dropped = true;
    }
  }
  // Swept after the named session goes, so a cancel still aborts an exchange
  // whose session crossed its expiry while the gateway was answering.
  sweepExpiredPairings();
  return dropped;
}

// ── Legacy base64 bundle import ─────────────────────────────────────────────
//
// The pre-pairing-link import path, still reached by the Electron IPC channel,
// the CLI dev-server route, and the Vite middleware. It shares `pairAssistant`
// with the pairing-session flow above and adds only base64 decoding.

/** Bounds what an untrusted bundle import can make a host buffer and decode. */
const MAX_BUNDLE_LENGTH = 64 * 1024;

type DecodedBundle =
  | { ok: true; credentials: PairedAssistantCredentials }
  | { ok: false; error: string };

/**
 * Decode and validate a base64 pairing bundle. Total and non-throwing:
 * malformed input yields a typed failure. `gatewayUrl` is persisted as
 * `runtimeUrl` and used to build fetch URLs, so it must be an absolute http(s)
 * URL rather than letting an invalid string through (which would crash
 * `new URL(...)` or break later client calls).
 */
function decodePairBundle(encoded: string): DecodedBundle {
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
    credentials: {
      gatewayUrl: b.gatewayUrl,
      token: b.token,
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
  | { ok: true; assistantId: string; updated: boolean; accessOnly: boolean }
  | { ok: false; status: number; error: string };

/**
 * The complete bundle-import host operation: validate the raw bundle value
 * (present, non-empty, within {@link MAX_BUNDLE_LENGTH}), decode it, and
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
  if (bundle.length > MAX_BUNDLE_LENGTH) {
    return { ok: false, status: 400, error: "Pairing bundle is too large" };
  }
  const decoded = decodePairBundle(bundle.trim());
  if (!decoded.ok) {
    return { ok: false, status: 400, error: decoded.error };
  }
  const result = pairAssistant(lockfilePaths, configDir, {
    credentials: decoded.credentials,
    name: typeof name === "string" && name ? name : undefined,
  });
  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error };
  }
  return {
    ok: true,
    assistantId: result.assistantId,
    updated: result.updated,
    accessOnly: result.accessOnly,
  };
}
