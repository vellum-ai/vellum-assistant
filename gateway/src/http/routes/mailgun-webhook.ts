import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import {
  resolveCredentialWithRefresh,
  verifySecretWithRefresh,
} from "../../credential-refresh.js";
import { StringDedupCache } from "../../dedup-cache.js";
import type { EmailReplySender } from "../../email/inbound-pipeline.js";
import { runEmailInboundPipeline } from "../../email/inbound-pipeline.js";
import type { VellumEmailPayload } from "../../email/normalize.js";
import { parseEmailAddress } from "../../email/normalize.js";
import { getLogger } from "../../logger.js";
import { readLimitedBodyBytes } from "../read-limited-body.js";

const log = getLogger("mailgun-webhook");

/**
 * Maximum age (in seconds) for the timestamp before we reject the
 * webhook as too old. Mailgun docs recommend a generous tolerance
 * since external delays can occur.
 */
const TIMESTAMP_TOLERANCE_SECONDS = 10 * 60;

// ── Mailgun HMAC signature verification ─────────────────────────────

/**
 * Verify a Mailgun webhook signature.
 *
 * Mailgun signs webhooks with HMAC-SHA256:
 *   HMAC-SHA256(signingKey, timestamp + token) → hex digest
 *
 * The `timestamp`, `token`, and `signature` are sent as fields in the
 * POST body (either as form fields or JSON properties).
 */
function verifyMailgunSignature(
  signingKey: string,
  timestamp: string,
  token: string,
  signature: string,
): boolean {
  if (!timestamp || !token || !signature) return false;

  // Reject stale timestamps to prevent replay attacks
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", signingKey)
    .update(timestamp + token, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signature);
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}

// ── Mailgun inbound payload parsing ─────────────────────────────────

/**
 * Parse form-encoded or JSON body into a flat field map. Takes already-read
 * bytes (size-capped upstream) and the content-type rather than the live
 * request, so the body is never buffered a second time and the payload cap is
 * enforced before parsing. Bytes are re-wrapped in a `Response` to reuse the
 * platform's multipart/form parser without losing binary fidelity.
 */
async function parseMailgunBody(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<Record<string, string> | null> {
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const formData = await new Response(bytes, {
        headers: { "content-type": contentType },
      }).formData();
      const fields: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        if (typeof value === "string") {
          fields[key] = value;
        }
      }
      return fields;
    } catch {
      return null;
    }
  }

  if (contentType.includes("application/json")) {
    try {
      const json = (await new Response(bytes).json()) as Record<
        string,
        unknown
      >;
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(json)) {
        if (typeof value === "string") {
          fields[key] = value;
        }
      }
      return fields;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Normalize Mailgun inbound fields into a `VellumEmailPayload`.
 */
function normalizeMailgunToVellumPayload(
  fields: Record<string, string>,
): VellumEmailPayload | null {
  const fromRaw = fields["from"] ?? fields["sender"];
  const recipient = fields["recipient"];
  const messageId = fields["Message-Id"];

  if (!fromRaw || !recipient || !messageId) return null;

  const parsed = parseEmailAddress(fromRaw);

  const inReplyTo = fields["In-Reply-To"] || undefined;
  const references = fields["References"] || undefined;

  // Derive a stable conversation ID using the root of the References
  // chain (first entry = thread root Message-ID per RFC 5322).
  // Falls back to recipient for new threads.
  const referencesRoot = references?.trim().split(/\s+/)[0];
  const conversationId = referencesRoot ?? recipient;

  // Prefer stripped-text (latest reply only); fall back to body-plain,
  // then body-html for HTML-only emails
  const strippedText = fields["stripped-text"] || undefined;
  const bodyText = fields["body-plain"] || fields["body-html"] || undefined;

  return {
    from: parsed.address,
    fromName: parsed.displayName,
    to: recipient,
    subject: fields["subject"],
    strippedText,
    bodyText,
    messageId,
    inReplyTo,
    references,
    conversationId,
    timestamp: fields["timestamp"],
  };
}

// ── Reply delivery ──────────────────────────────────────────────────

/**
 * Reply sender using the Mailgun Messages API. The sending domain is
 * derived from the inbound recipient address (`from` side of the reply).
 */
function buildMailgunReplySender(
  apiKey: string,
  log: Logger,
): EmailReplySender {
  return async ({ kind, from, to, subject, text, inReplyTo }) => {
    const domain = from.split("@")[1];
    if (!domain) {
      return;
    }
    try {
      const form = new URLSearchParams();
      form.set("from", from);
      form.set("to", to);
      form.set("subject", subject);
      form.set("text", text);
      if (inReplyTo) {
        form.set("h:In-Reply-To", inReplyTo);
      }

      const sendResponse = await fetch(
        `https://api.mailgun.net/v3/${domain}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
          },
          body: form,
        },
      );
      if (sendResponse.ok) {
        log.info({ from, to }, `Sent ${kind} reply via Mailgun`);
      } else {
        log.warn(
          { status: sendResponse.status, from, to },
          `Failed to send ${kind} reply via Mailgun`,
        );
      }
    } catch (err) {
      log.error({ err, from, to }, `Error sending ${kind} reply via Mailgun`);
    }
  };
}

// ── Webhook handler factory ─────────────────────────────────────────

export function createMailgunWebhookHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
) {
  // 24-hour TTL — Mailgun token is unique per webhook delivery
  const dedupCache = new StringDedupCache(24 * 60 * 60_000);

  const handler = async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Cap body buffering before the (unauthenticated) signature check; a
    // header-only guard is bypassable via chunked / absent Content-Length.
    const bodyResult = await readLimitedBodyBytes(
      req,
      config.maxWebhookPayloadBytes,
    );
    if (bodyResult.status === "too_large") {
      tlog.warn("Mailgun webhook payload too large");
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }
    if (bodyResult.status === "unreadable") {
      return Response.json({ error: "Failed to read body" }, { status: 400 });
    }

    // ── Parse body ──────────────────────────────────────────────────
    // Mailgun inbound routes POST form-encoded data, not JSON.

    const fields = await parseMailgunBody(
      bodyResult.bytes,
      req.headers.get("content-type") ?? "",
    );
    if (!fields) {
      return Response.json({ error: "Failed to parse body" }, { status: 400 });
    }

    // ── Credential resolution ───────────────────────────────────────

    const signingKey = await resolveCredentialWithRefresh(
      caches?.credentials,
      credentialKey("mailgun", "webhook_signing_key"),
    );

    if (!signingKey) {
      tlog.warn(
        "Mailgun webhook signing key not configured — rejecting request",
      );
      return Response.json(
        { error: "Webhook signing key not configured" },
        { status: 409 },
      );
    }

    // ── Signature verification ──────────────────────────────────────

    const timestamp = fields["timestamp"] ?? "";
    const token = fields["token"] ?? "";
    const signature = fields["signature"] ?? "";

    const signatureValid = await verifySecretWithRefresh({
      credentials: caches?.credentials,
      key: credentialKey("mailgun", "webhook_signing_key"),
      verify: (key) => verifyMailgunSignature(key, timestamp, token, signature),
      log: tlog,
      label: "Mailgun webhook signature",
    });

    if (!signatureValid) {
      tlog.warn("Mailgun webhook signature verification failed");
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Dedup by token ──────────────────────────────────────────────
    // Mailgun's `token` field is unique per delivery — use it for dedup
    // as recommended by their docs for replay attack prevention.

    if (token && !dedupCache.reserve(token)) {
      tlog.info({ token }, "Duplicate Mailgun webhook token, ignoring");
      return Response.json({ ok: true });
    }

    // ── Normalize ───────────────────────────────────────────────────

    const vellumPayload = normalizeMailgunToVellumPayload(fields);
    if (!vellumPayload) {
      tlog.debug("Mailgun webhook missing required fields, acknowledging");
      if (token) dedupCache.mark(token);
      return Response.json({ ok: true });
    }

    // ── Forward through the shared email pipeline ───────────────────

    const apiKey = await resolveCredentialWithRefresh(
      caches?.credentials,
      credentialKey("mailgun", "api_key"),
    );
    if (!apiKey) {
      tlog.debug("Mailgun API key not configured — replies disabled");
    }

    return runEmailInboundPipeline({
      config,
      log: tlog,
      label: "Mailgun",
      source: "mailgun",
      dedupCache,
      dedupKey: token,
      vellumPayload,
      traceId,
      sendReply: apiKey ? buildMailgunReplySender(apiKey, tlog) : undefined,
    });
  };

  return { handler, dedupCache };
}
