import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { verifyTwilioSignature } from "./verify.js";

const log = getLogger("twilio-validate");

function firstHeaderValue(value: string | null): string | undefined {
  if (!value) return undefined;
  const first = value.split(",")[0]?.trim();
  return first ? first : undefined;
}

/**
 * Build URL candidates Twilio may have used when computing the webhook signature.
 *
 * Precedence:
 * 1) Canonical configured ingress URL (when present)
 * 2) Forwarded public URL headers from tunnel/proxy
 * 3) Raw request URL (last-resort fallback)
 */
function buildSignatureUrlCandidates(req: Request, config: GatewayConfig): string[] {
  const parsedUrl = new URL(req.url);
  const pathAndQuery = parsedUrl.pathname + parsedUrl.search;
  const candidates: string[] = [];

  const addBase = (base: string | undefined): void => {
    if (!base) return;
    const normalized = base.trim().replace(/\/+$/, "");
    if (!normalized) return;
    const candidate = `${normalized}${pathAndQuery}`;
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  addBase(config.ingressPublicBaseUrl);

  const forwardedProto =
    firstHeaderValue(req.headers.get("x-forwarded-proto")) ??
    firstHeaderValue(req.headers.get("x-original-proto"));
  const forwardedHost =
    firstHeaderValue(req.headers.get("x-forwarded-host")) ??
    firstHeaderValue(req.headers.get("x-original-host"));
  if (forwardedProto && forwardedHost) {
    addBase(`${forwardedProto}://${forwardedHost}`);
  }

  // Include the raw request URL as a fallback only when no canonical public
  // URL is configured. When ingressPublicBaseUrl is set, we enforce that the
  // signature matches the public URL (or forwarded headers) to prevent
  // accepting signatures computed against the local/internal URL.
  if (!config.ingressPublicBaseUrl && !candidates.includes(req.url)) {
    candidates.push(req.url);
  }

  return candidates;
}

export type TwilioValidationSuccess = {
  /** Raw form-urlencoded body as a string. */
  rawBody: string;
  /** Parsed key-value pairs from the form body. */
  params: Record<string, string>;
};

/**
 * Validate an incoming Twilio webhook request:
 * - Enforces POST method
 * - Enforces payload size limits
 * - Validates X-Twilio-Signature via HMAC-SHA1
 *
 * Returns the parsed body on success, or a Response on failure.
 */
export async function validateTwilioWebhookRequest(
  req: Request,
  config: GatewayConfig,
): Promise<TwilioValidationSuccess | Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Payload size guard (Content-Length header)
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > config.maxWebhookPayloadBytes) {
    log.warn({ contentLength }, "Twilio webhook payload too large");
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  // Fail-closed: reject if no auth token is configured
  if (!config.twilioAuthToken) {
    log.error("Twilio auth token not configured — rejecting webhook (fail-closed)");
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return Response.json({ error: "Failed to read body" }, { status: 400 });
  }

  // Payload size guard (actual body size)
  if (Buffer.byteLength(rawBody) > config.maxWebhookPayloadBytes) {
    log.warn({ bodyLength: Buffer.byteLength(rawBody) }, "Twilio webhook payload too large");
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  // Parse form-urlencoded body
  const formData = new URLSearchParams(rawBody);
  const params: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    params[key] = value;
  }

  // Validate signature
  const signature = req.headers.get("x-twilio-signature");
  if (!signature) {
    log.warn("Twilio webhook request missing X-Twilio-Signature header");
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const signatureUrlCandidates = buildSignatureUrlCandidates(req, config);
  const isValid = signatureUrlCandidates.some((candidate) =>
    verifyTwilioSignature(candidate, params, signature, config.twilioAuthToken!),
  );

  if (!isValid) {
    log.warn(
      { candidateCount: signatureUrlCandidates.length },
      "Twilio webhook signature validation failed",
    );
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return { rawBody, params };
}
