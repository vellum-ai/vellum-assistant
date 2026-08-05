/**
 * Declared signature verification for plugin ingress routes.
 *
 * A plugin route that receives third-party webhooks cannot use the platform
 * scheme (`Vellum-Signature`, see `../http/vellum-signature.ts`): the caller is
 * Comms, or Photon, or Stripe, and it signs the way it signs. Before this,
 * such a route could be declared, approved, registered with the vendor, and
 * then 403 every delivery — the only schemes the gateway knew were its own.
 *
 * So a route may declare *how* to verify it, as data. The gateway implements
 * one HMAC engine and reads the vendor's specifics — algorithm, which header
 * carries the digest, how it is encoded, and exactly which bytes it covers —
 * out of the manifest. A third vendor is a manifest edit rather than gateway
 * code, which is the whole point: the alternative is a growing switch of
 * per-vendor verifiers that only the gateway team can extend.
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
 * - **Raw bytes.** `body` is the bytes as received. Every vendor here signs
 *   pre-parse, and a re-serialized JSON body does not match — a failure that
 *   looks exactly like a wrong secret.
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
 * `"body"` is the raw request body. `{ header }` is a request header's value —
 * a header named here but absent from the request fails verification rather
 * than contributing an empty string, or a caller could omit a timestamp to
 * change what was signed. `{ literal }` is a fixed separator or version tag.
 *
 * Together these cover the shapes vendors actually use: `body` alone (Comms,
 * GitHub), and `<tag>:<timestamp>:<body>` (Photon, Slack).
 */
export const PayloadPartSchema = z.union([
  z.literal("body"),
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
 * How a route is verified.
 *
 * A discriminated union of one member today. It is a union rather than a bare
 * object so a second scheme — a vendor that signs an asymmetric signature, say
 * — is an added member with its own required fields, and every existing
 * manifest keeps parsing.
 */
export const IngressVerificationSchema = z.discriminatedUnion("kind", [
  HmacVerificationSchema,
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

/** Assemble the exact bytes a signature covers, or the header that is missing. */
function buildPayload(
  parts: readonly PayloadPart[],
  headers: Headers,
  body: Uint8Array,
): Buffer | { missingHeader: string } {
  const chunks: Buffer[] = [];

  for (const part of parts) {
    if (part === "body") {
      chunks.push(Buffer.from(body));
      continue;
    }
    if ("literal" in part) {
      chunks.push(Buffer.from(part.literal, "utf8"));
      continue;
    }
    const value = headers.get(part.header);
    if (value === null) {
      return { missingHeader: part.header };
    }
    chunks.push(Buffer.from(value, "utf8"));
  }

  return Buffer.concat(chunks);
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
}): VerificationResult {
  const { verification, headers, body, secret } = opts;
  const nowMs = opts.nowMs ?? Date.now();

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

  const payload = buildPayload(verification.payload, headers, body);
  if ("missingHeader" in payload) {
    return { ok: false, reason: "missing_payload_header" };
  }

  const expected = createHmac(verification.algorithm, secret)
    .update(payload)
    .digest();

  // Length is compared first because timingSafeEqual throws on a mismatch, and
  // digest length is a function of the declared algorithm — public either way.
  if (digest.length !== expected.length) {
    return { ok: false, reason: "bad_signature" };
  }
  return timingSafeEqual(digest, expected)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
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
