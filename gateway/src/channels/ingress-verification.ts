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
 * encoded, and exactly which bytes it covers, all read from the manifest.
 * Standard Webhooks is a second kind because its secret encoding and
 * multi-signature header cannot be expressed as that list. A third HMAC
 * vendor is still a manifest edit rather than gateway code. A fourth
 * complete scheme is an added union member.
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
 * Twilio's request signature.
 *
 * A third complete scheme, and the reason it cannot be an `hmac` payload
 * list: Twilio signs **the full request URL** followed by the POST params
 * sorted by key and concatenated as `key` + `value` — a byte string the
 * payload-part vocabulary cannot express, over a **form-encoded** body, with
 * the digest in `X-Twilio-Signature` as base64 HMAC-SHA1 keyed by the
 * account auth token. No timestamp, so no freshness window is possible.
 *
 * The URL a delivery was signed against is not necessarily the URL the
 * gateway sees (platform proxy, reverse proxy, tunnel), so verification
 * tries a candidate list — the platform-injected original URL first, then
 * forwarded headers, then the configured public base, then the raw request
 * URL — mirroring `twilio/validate-webhook.ts` for the built-in Twilio
 * routes.
 */
export const TwilioVerificationSchema = z
  .object({
    kind: z.literal("twilio"),
    secret: z.object({ field: CredentialFieldSchema }).strict(),
  })
  .strict();

/** Header every Twilio-signed delivery carries its digest in. */
export const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";

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
  TwilioVerificationSchema,
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
 * The URLs a Twilio delivery might have been signed against.
 *
 * Twilio signs the full URL it POSTed to. The gateway can sit behind the
 * platform callback proxy, a reverse proxy, or a tunnel, so the raw request
 * URL is only the last candidate, not the first. The order mirrors
 * `twilio/validate-webhook.ts` for the built-in Twilio routes: the
 * platform-injected original URL is exact, forwarded headers reconstruct the
 * public spelling, the configured base covers a gateway that knows its own
 * public address, and the raw URL is the fallback that keeps a valid
 * signature from being rejected in a setup none of the above described.
 */
function twilioSignatureUrlCandidates(opts: {
  headers: Headers;
  requestUrl: string;
  publicBaseUrl?: string;
}): string[] {
  const candidates: string[] = [];
  const add = (url: string | undefined): void => {
    if (url && !candidates.includes(url)) candidates.push(url);
  };

  const injected = opts.headers.get("x-vellum-ingress-url");
  if (injected) add(injected);

  const proto =
    opts.headers.get("x-forwarded-proto") ?? opts.headers.get("x-original-proto");
  const host =
    opts.headers.get("x-forwarded-host") ?? opts.headers.get("x-original-host");
  if (proto && host) {
    const raw = new URL(opts.requestUrl);
    add(`${proto}://${host}${raw.pathname}${raw.search}`);
  }

  if (opts.publicBaseUrl) {
    const raw = new URL(opts.requestUrl);
    const base = opts.publicBaseUrl.replace(/\/+$/, "");
    if (base) add(`${base}${raw.pathname}${raw.search}`);
  }

  add(opts.requestUrl);
  return candidates;
}

/**
 * Verify a Twilio-signed delivery.
 *
 * The digest is base64 HMAC-SHA1 over one candidate URL plus the form params
 * sorted by key and concatenated as `key` + `value`, keyed by the auth token.
 * Any candidate matching is a pass: the candidates exist precisely because
 * which spelling Twilio signed depends on the deployment's proxy chain, and
 * only one of them can be right while none of them is knowable here.
 */
function verifyTwilio(opts: {
  headers: Headers;
  body: Uint8Array;
  secret: string;
  requestUrl: string;
  publicBaseUrl?: string;
}): VerificationResult {
  const { headers, body, secret, requestUrl } = opts;
  if (!secret) {
    return { ok: false, reason: "missing_signature" };
  }

  const presented = headers.get(TWILIO_SIGNATURE_HEADER);
  if (!presented) {
    return { ok: false, reason: "missing_signature" };
  }

  // Form params, parsed from the raw bytes. Twilio posts
  // `application/x-www-form-urlencoded`; the signature covers the parsed
  // pairs, not the raw body, so a re-encoded body with the same pairs
  // verifies and a JSON body cannot.
  const params = new URLSearchParams(
    Buffer.from(body).toString("utf8"),
  );
  const sorted = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}${value}`)
    .join("");

  for (const candidate of twilioSignatureUrlCandidates({
    headers,
    requestUrl,
    publicBaseUrl: opts.publicBaseUrl,
  })) {
    const expected = createHmac("sha1", secret)
      .update(`${candidate}${sorted}`)
      .digest("base64");
    // String compare is safe here: both sides are base64 of a SHA1 digest,
    // so the lengths are public and fixed, and `timingSafeEqual` would throw
    // on the length mismatch this comparison is allowed to have.
    if (expected === presented) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "bad_signature" };
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
  /**
   * The raw request URL, as this gateway sees it. Only the `twilio` kind
   * reads it: every other scheme signs bytes the gateway already has.
   */
  requestUrl?: string;
  /** The assistant's configured public base URL, for URL reconstruction. */
  publicBaseUrl?: string;
}): VerificationResult {
  const { verification, headers, body, secret } = opts;
  const nowMs = opts.nowMs ?? Date.now();

  if (verification.kind === "standard-webhooks") {
    return verifyStandardWebhooks({ headers, body, secret, nowMs });
  }

  if (verification.kind === "twilio") {
    if (!opts.requestUrl) {
      // A caller that cannot say what URL it is serving has no way to check
      // a signature that covers it. Fail closed rather than verify against
      // a guess.
      return { ok: false, reason: "bad_signature" };
    }
    return verifyTwilio({
      headers,
      body,
      secret,
      requestUrl: opts.requestUrl,
      publicBaseUrl: opts.publicBaseUrl,
    });
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
