/**
 * Declared signature verification for plugin ingress routes.
 *
 * A plugin route that receives third-party webhooks cannot use the platform
 * scheme (`Vellum-Signature`, see `../http/vellum-signature.ts`): the caller is
 * Comms, or Photon, or Stripe, and it signs the way it signs. Before this,
 * such a route could be declared, approved, registered with the vendor, and
 * then 403 every delivery — the only schemes the gateway knew were its own.
 *
 * So a route may declare *how* to verify it, as data. Most vendors fit the
 * HMAC engine: algorithm, which header carries the digest, how it is
 * encoded, and the canonical request values it covers, all read from the
 * manifest. Standard Webhooks is a second kind because its secret encoding
 * and multi-signature header cannot be expressed as that list. Bearer tokens
 * are another complete scheme because an automation client presents a static
 * secret rather than calculating a digest. A vendor that uses HMAC remains a
 * manifest edit rather than gateway code. A distinct complete scheme is an
 * added union member.
 *
 * What stays gateway-side, and must:
 *
 * - **The credential's service.** A descriptor names a *field*; the service is
 *   composed from the plugin's own directory name by the caller. A manifest
 *   that could name the service could point a route at another plugin's secret,
 *   or at the platform's.
 * - **Fail-closed parsing.** Anything unrecognized — an unknown `kind`,
 *   algorithm, encoding, or an extra key — fails the manifest rather than
 *   falling back to the platform scheme. A route the plugin believes is
 *   verified one way and the gateway verifies another is worse than no route.
 * - **Canonical payload parts.** `body` is the bytes as received. Other
 *   payload parts declare their own canonicalization, so a manifest cannot
 *   imply one representation while the gateway verifies another.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/** Hash functions a descriptor may name. */
export const HmacAlgorithmSchema = z.enum(["sha1", "sha256", "sha512"]);

/** How a digest is written in its header. */
export const DigestEncodingSchema = z.enum(["hex", "base64"]);

/**
 * A credential field under the declaring plugin's own service.
 *
 * Constrained rather than free-form: the value is composed into a store key,
 * and a field carrying `/` or `..` would let a manifest reach a service it does
 * not own. The service half is never declarable at all — see the module note.
 */
export const CredentialFieldSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9_]*$/,
    "credential field must be lowercase alphanumeric with underscores",
  );

/**
 * One piece of the byte string a signature covers, in order.
 *
 * `"body"` is the raw request body. `{ header }` is a request header's value:
 * an absent header fails verification rather than contributing an empty value.
 * `{ literal }` is a fixed separator or version tag. `"request-url"` is the
 * public URL that received the request. The gateway tries its trusted
 * reconstruction candidates because proxying can change the raw local URL.
 * `"form-params"` parses the urlencoded body, sorts entries by key, and
 * concatenates each key and value.
 */
export const PayloadPartSchema = z.union([
  z.literal("body"),
  z.literal("request-url"),
  z.literal("form-params"),
  z.object({ literal: z.string().min(1) }).strict(),
  z.object({ header: z.string().min(1) }).strict(),
]);
export type PayloadPart = z.infer<typeof PayloadPartSchema>;

export const TimestampFormatSchema = z.enum([
  "unix-seconds",
  "unix-millis",
  "rfc3339",
]);

/** Ceiling on a declared replay window. A day is already generous. */
export const MAX_FRESHNESS_TOLERANCE_SECONDS = 24 * 60 * 60;

/**
 * Replay guard.
 *
 * Optional because not every vendor offers one: a signature over the body
 * alone stays valid for as long as the secret does, and a vendor that binds no
 * timestamp cannot be given a window by us. Where one exists, declaring it is
 * what makes a captured delivery stop working.
 */
export const FreshnessSchema = z
  .object({
    header: z.string().min(1),
    format: TimestampFormatSchema,
    toleranceSeconds: z
      .number()
      .int()
      .positive()
      .max(MAX_FRESHNESS_TOLERANCE_SECONDS),
  })
  .strict();

export const HmacVerificationSchema = z
  .object({
    kind: z.literal("hmac"),
    algorithm: HmacAlgorithmSchema,
    secret: z.object({ field: CredentialFieldSchema }).strict(),
    signature: z
      .object({
        header: z.string().min(1),
        encoding: DigestEncodingSchema,
        /** Stripped before comparison — `sha256=`, `v0=`. */
        prefix: z.string().min(1).optional(),
      })
      .strict(),
    payload: z.array(PayloadPartSchema).min(1),
    freshness: FreshnessSchema.optional(),
  })
  .strict();

/**
 * Standard Webhooks (`standardwebhooks.com`).
 *
 * A complete scheme, not a list of HMAC parts: the signed content is always
 * `{webhook-id}.{webhook-timestamp}.{raw body}`, the key is the base64
 * payload of a `whsec_` secret, and the header is
 * `webhook-signature: v1,<base64>` (space-separated when rotated). Linq
 * and any other vendor that adopted the spec declare this kind instead of
 * reconstructing those rules as an `hmac` payload list, which cannot decode
 * the secret or accept multiple signatures.
 *
 * Replay window is five minutes, matching the spec's default.
 */
export const StandardWebhooksVerificationSchema = z
  .object({
    kind: z.literal("standard-webhooks"),
    secret: z.object({ field: CredentialFieldSchema }).strict(),
  })
  .strict();

/**
 * Static bearer-token verification for automation clients.
 *
 * The credential lives under the declaring plugin's own service. A caller
 * presents it only as `Authorization: Bearer <token>`: accepting query
 * parameters would turn URLs, which are routinely retained in logs and
 * history, into reusable credentials.
 */
export const BearerVerificationSchema = z
  .object({
    kind: z.literal("bearer"),
    secret: z.object({ field: CredentialFieldSchema }).strict(),
  })
  .strict();

/** Replay window Standard Webhooks requires. */
export const STANDARD_WEBHOOKS_TOLERANCE_SECONDS = 5 * 60;

/**
 * How a route is verified.
 *
 * A discriminated union. A second scheme is an added member with its own
 * required fields, and every existing manifest keeps parsing.
 */
export const IngressVerificationSchema = z.discriminatedUnion("kind", [
  HmacVerificationSchema,
  StandardWebhooksVerificationSchema,
  BearerVerificationSchema,
]);
export type IngressVerification = z.infer<typeof IngressVerificationSchema>;

/** Why a delivery was refused. For gateway logs; callers are told nothing. */
export type VerificationRejection =
  | "missing_signature"
  | "malformed_signature"
  | "missing_payload_header"
  | "missing_timestamp"
  | "stale_timestamp"
  | "bad_signature";

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: VerificationRejection };

/**
 * The public URLs a caller might have signed.
 *
 * The platform callback proxy can preserve the original URL explicitly, while
 * a reverse proxy can expose it through forwarding headers. A configured
 * public base and the raw request URL cover direct deployments. Each distinct
 * candidate is tried because only the caller knows which public spelling it
 * received.
 */
function requestUrlCandidates(opts: {
  headers: Headers;
  requestUrl?: string;
  publicBaseUrl?: string;
}): string[] {
  const { requestUrl } = opts;
  if (!requestUrl) {
    return [];
  }

  const candidates: string[] = [];
  const add = (url: string | null | undefined): void => {
    if (url && !candidates.includes(url)) {
      candidates.push(url);
    }
  };

  add(opts.headers.get("x-vellum-ingress-url"));

  let raw: URL | undefined;
  try {
    raw = new URL(requestUrl);
  } catch {
    // The raw request URL remains a candidate below. It is valid for real
    // Request objects, but keeping this helper total makes direct callers
    // fail closed rather than throw on malformed input.
  }

  const proto =
    opts.headers.get("x-forwarded-proto") ?? opts.headers.get("x-original-proto");
  const host =
    opts.headers.get("x-forwarded-host") ?? opts.headers.get("x-original-host");
  if (raw && proto && host) {
    add(`${proto}://${host}${raw.pathname}${raw.search}`);
  }

  if (raw && opts.publicBaseUrl) {
    const base = opts.publicBaseUrl.replace(/\/+$/, "");
    if (base) {
      add(`${base}${raw.pathname}${raw.search}`);
    }
  }

  add(requestUrl);
  return candidates;
}

/** Canonicalize a urlencoded body as sorted key and value strings. */
function formParamsPayload(body: Uint8Array): Buffer {
  const params = new URLSearchParams(Buffer.from(body).toString("utf8"));
  const canonical = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}${value}`)
    .join("");
  return Buffer.from(canonical, "utf8");
}

type PayloadBuildFailure =
  | { missingHeader: string }
  | { missingRequestUrl: true };

/** Assemble every candidate byte string a signature can cover. */
function buildPayload(
  parts: readonly PayloadPart[],
  headers: Headers,
  body: Uint8Array,
  context: { requestUrl?: string; publicBaseUrl?: string },
): Buffer[] | PayloadBuildFailure {
  let payloads: Buffer[][] = [[]];

  for (const part of parts) {
    let values: Buffer[];
    if (part === "body") {
      values = [Buffer.from(body)];
    } else if (part === "request-url") {
      const candidates = requestUrlCandidates({
        headers,
        requestUrl: context.requestUrl,
        publicBaseUrl: context.publicBaseUrl,
      });
      if (candidates.length === 0) {
        return { missingRequestUrl: true };
      }
      values = candidates.map((candidate) => Buffer.from(candidate, "utf8"));
    } else if (part === "form-params") {
      values = [formParamsPayload(body)];
    } else if ("literal" in part) {
      values = [Buffer.from(part.literal, "utf8")];
    } else {
      const value = headers.get(part.header);
      if (value === null) {
        return { missingHeader: part.header };
      }
      values = [Buffer.from(value, "utf8")];
    }

    payloads = payloads.flatMap((payload) =>
      values.map((value) => [...payload, value]),
    );
  }

  return payloads.map((payload) => Buffer.concat(payload));
}

/**
 * Decode a presented digest, or `null` when it is not that encoding.
 *
 * Validated before decoding because both decoders are lenient: `Buffer.from`
 * drops characters it does not recognize, so an attacker-supplied digest could
 * otherwise decode to a *shorter* buffer that happens to compare equal against
 * a truncated expectation.
 */
function decodeDigest(
  value: string,
  encoding: "hex" | "base64",
): Buffer | null {
  if (encoding === "hex") {
    if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) return null;
    return Buffer.from(value, "hex");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  // Round-trip guard: base64 has several spellings of the same bytes, and only
  // the canonical one should be accepted.
  return decoded.toString("base64").replace(/=+$/, "") ===
    value.replace(/=+$/, "")
    ? decoded
    : null;
}

/**
 * Decode a Standard Webhooks secret into the HMAC key bytes.
 *
 * A `whsec_` prefix is stripped, then the remainder is base64. A secret
 * stored without the prefix is decoded as-is so a caller that already
 * stripped it still verifies.
 */
function standardWebhooksKey(secret: string): Buffer | null {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  if (!encoded) {
    return null;
  }
  const key = Buffer.from(encoded, "base64");
  return key.length > 0 ? key : null;
}

/**
 * Verify a Standard Webhooks delivery.
 *
 * Headers are looked up case-insensitively (`Headers.get`). The signed
 * content is `{webhook-id}.{webhook-timestamp}.{raw body}`. Any `v1,`
 * signature in the space-separated header is enough.
 */
function verifyStandardWebhooks(opts: {
  headers: Headers;
  body: Uint8Array;
  secret: string;
  nowMs: number;
}): VerificationResult {
  const { headers, body, secret, nowMs } = opts;
  if (!secret) {
    return { ok: false, reason: "missing_signature" };
  }

  const msgId = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatureHeader = headers.get("webhook-signature");
  if (!signatureHeader) {
    return { ok: false, reason: "missing_signature" };
  }
  if (msgId === null) {
    return { ok: false, reason: "missing_payload_header" };
  }
  if (timestamp === null) {
    return { ok: false, reason: "missing_timestamp" };
  }

  if (!/^-?\d+$/.test(timestamp)) {
    return { ok: false, reason: "missing_timestamp" };
  }
  const stampedMs = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(Number(timestamp))) {
    return { ok: false, reason: "missing_timestamp" };
  }
  if (Math.abs(nowMs - stampedMs) > STANDARD_WEBHOOKS_TOLERANCE_SECONDS * 1000) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const key = standardWebhooksKey(secret);
  if (!key) {
    return { ok: false, reason: "missing_signature" };
  }

  const signedContent = Buffer.concat([
    Buffer.from(`${msgId}.${timestamp}.`, "utf8"),
    Buffer.from(body),
  ]);
  const expected = createHmac("sha256", key).update(signedContent).digest();

  let sawV1 = false;
  for (const entry of signatureHeader.split(" ")) {
    if (!entry.startsWith("v1,")) {
      continue;
    }
    sawV1 = true;
    const digest = decodeDigest(entry.slice(3), "base64");
    if (!digest || digest.length !== expected.length) {
      continue;
    }
    if (timingSafeEqual(digest, expected)) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    reason: sawV1 ? "bad_signature" : "malformed_signature",
  };
}

/** Verify a static bearer token without exposing it to string comparison timing. */
function verifyBearer(opts: {
  headers: Headers;
  secret: string;
}): VerificationResult {
  const { headers, secret } = opts;
  if (!secret) {
    return { ok: false, reason: "missing_signature" };
  }

  const authorization = headers.get("authorization");
  if (!authorization) {
    return { ok: false, reason: "missing_signature" };
  }
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) {
    return { ok: false, reason: "malformed_signature" };
  }

  const presented = Buffer.from(match[1]!, "utf8");
  const expected = Buffer.from(secret, "utf8");
  if (presented.length !== expected.length) {
    return { ok: false, reason: "bad_signature" };
  }
  return timingSafeEqual(presented, expected)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}

/** Unix milliseconds for a timestamp in the declared format, or `null`. */
function timestampMs(value: string, format: string): number | null {
  if (format === "rfc3339") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (!/^-?\d+$/.test(value)) return null;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return null;
  return format === "unix-millis" ? numeric : numeric * 1000;
}

/**
 * Verify a delivery against the route's declared scheme.
 *
 * Order matters: the freshness check runs before the HMAC because it is the
 * cheap one and rejects a replay without touching the secret.
 */
export function verifyDeclaredSignature(opts: {
  verification: IngressVerification;
  headers: Headers;
  body: Uint8Array;
  secret: string;
  nowMs?: number;
  /** The raw request URL, used by an HMAC payload containing `request-url`. */
  requestUrl?: string;
  /** The assistant's configured public base URL for URL reconstruction. */
  publicBaseUrl?: string;
}): VerificationResult {
  const { verification, headers, body, secret } = opts;
  const nowMs = opts.nowMs ?? Date.now();

  if (verification.kind === "standard-webhooks") {
    return verifyStandardWebhooks({ headers, body, secret, nowMs });
  }
  if (verification.kind === "bearer") {
    return verifyBearer({ headers, secret });
  }

  const presented = headers.get(verification.signature.header);
  if (!presented || !secret) {
    return { ok: false, reason: "missing_signature" };
  }

  const { prefix } = verification.signature;
  if (prefix && !presented.startsWith(prefix)) {
    return { ok: false, reason: "malformed_signature" };
  }
  const digest = decodeDigest(
    prefix ? presented.slice(prefix.length) : presented,
    verification.signature.encoding,
  );
  if (!digest) {
    return { ok: false, reason: "malformed_signature" };
  }

  const { freshness } = verification;
  if (freshness) {
    const stamped = headers.get(freshness.header);
    if (stamped === null) {
      return { ok: false, reason: "missing_timestamp" };
    }
    const ms = timestampMs(stamped, freshness.format);
    if (ms === null) {
      return { ok: false, reason: "missing_timestamp" };
    }
    if (Math.abs(nowMs - ms) > freshness.toleranceSeconds * 1000) {
      return { ok: false, reason: "stale_timestamp" };
    }
  }

  const payloads = buildPayload(verification.payload, headers, body, {
    requestUrl: opts.requestUrl,
    publicBaseUrl: opts.publicBaseUrl,
  });
  if ("missingHeader" in payloads) {
    return { ok: false, reason: "missing_payload_header" };
  }
  if ("missingRequestUrl" in payloads) {
    return { ok: false, reason: "bad_signature" };
  }

  for (const payload of payloads) {
    const expected = createHmac(verification.algorithm, secret)
      .update(payload)
      .digest();

    // Length is compared first because timingSafeEqual throws on a mismatch,
    // and digest length is a function of the declared algorithm.
    if (digest.length === expected.length && timingSafeEqual(digest, expected)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "bad_signature" };
}

/**
 * Stable string for a descriptor, for the approval digest.
 *
 * Keys are emitted in sorted order so a reformatted manifest that means the
 * same thing does not drop a plugin back to `pending`, while any change to
 * what is verified or which secret verifies it does.
 */
export function canonicalVerification(
  verification: IngressVerification,
): string {
  return JSON.stringify(sortDeep(verification));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => [key, sortDeep(nested)]),
  );
}
