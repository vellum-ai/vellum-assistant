import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { verifyTwilioSignature } from "./verify.js";

const log = getLogger("twilio-validate");

type TwilioWebhookKind = "voice" | "status" | "connect-action" | "unknown";

type SignatureUrlCandidateSource =
  | "configured_ingress"
  | "forwarded_headers"
  | "raw_request";

type SignatureUrlCandidate = {
  source: SignatureUrlCandidateSource;
  url: string;
};

function firstHeaderValue(value: string | null): string | undefined {
  if (!value) return undefined;
  const first = value.split(",")[0]?.trim();
  return first ? first : undefined;
}

function inferWebhookKind(reqUrl: string): TwilioWebhookKind {
  const pathname = new URL(reqUrl).pathname;

  if (
    pathname === "/webhooks/twilio/voice" ||
    pathname === "/v1/calls/twilio/voice-webhook"
  ) {
    return "voice";
  }

  if (
    pathname === "/webhooks/twilio/status" ||
    pathname === "/v1/calls/twilio/status"
  ) {
    return "status";
  }

  if (
    pathname === "/webhooks/twilio/connect-action" ||
    pathname === "/v1/calls/twilio/connect-action"
  ) {
    return "connect-action";
  }

  return "unknown";
}

function normalizeUrlForLog(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return "[malformed-url]";
  }
}

function buildSignatureUrlCandidateDetails(
  req: Request,
  config: GatewayConfig,
): SignatureUrlCandidate[] {
  const parsedUrl = new URL(req.url);
  const pathAndQuery = parsedUrl.pathname + parsedUrl.search;
  const candidates: SignatureUrlCandidate[] = [];

  const addCandidate = (
    url: string | undefined,
    source: SignatureUrlCandidateSource,
  ): void => {
    if (!url) return;
    if (!candidates.some((candidate) => candidate.url === url)) {
      candidates.push({ source, url });
    }
  };

  const addBase = (
    base: string | undefined,
    source: SignatureUrlCandidateSource,
  ): void => {
    if (!base) return;
    const normalized = base.trim().replace(/\/+$/, "");
    if (!normalized) return;
    addCandidate(`${normalized}${pathAndQuery}`, source);
  };

  addBase(config.ingressPublicBaseUrl, "configured_ingress");

  const forwardedProto =
    firstHeaderValue(req.headers.get("x-forwarded-proto")) ??
    firstHeaderValue(req.headers.get("x-original-proto"));
  const forwardedHost =
    firstHeaderValue(req.headers.get("x-forwarded-host")) ??
    firstHeaderValue(req.headers.get("x-original-host"));
  if (forwardedProto && forwardedHost) {
    addBase(`${forwardedProto}://${forwardedHost}`, "forwarded_headers");
  }

  // Always include the raw request URL as the final fallback candidate so
  // valid signatures are not rejected when the other candidates are stale or
  // incorrectly reconstructed (e.g. mixed proxy/tunnel setups).
  addCandidate(req.url, "raw_request");

  return candidates;
}

function buildValidationDiagnostics(
  req: Request,
  config: GatewayConfig,
): {
  logContext: {
    authTokenConfigured: boolean;
    candidateCount: number;
    candidateSources: SignatureUrlCandidateSource[];
    candidateUrls: string[];
    webhookKind: TwilioWebhookKind;
  };
  signatureUrlCandidates: SignatureUrlCandidate[];
} {
  const signatureUrlCandidates = buildSignatureUrlCandidateDetails(req, config);
  const logContext = {
    webhookKind: inferWebhookKind(req.url),
    authTokenConfigured: Boolean(config.twilioAuthToken),
    candidateCount: signatureUrlCandidates.length,
    candidateSources: signatureUrlCandidates.map(
      (candidate) => candidate.source,
    ),
    candidateUrls: signatureUrlCandidates.map((candidate) =>
      normalizeUrlForLog(candidate.url),
    ),
  };

  return {
    logContext,
    signatureUrlCandidates,
  };
}

/**
 * Track which candidate validated the signature so we can warn about
 * fallback usage when `ingressPublicBaseUrl` is configured.
 *
 * @internal Exported for testing only.
 */
export function findValidatingCandidateIndex(
  candidates: string[],
  params: Record<string, string>,
  signature: string,
  authToken: string,
): number {
  for (let i = 0; i < candidates.length; i++) {
    if (verifyTwilioSignature(candidates[i], params, signature, authToken)) {
      return i;
    }
  }
  return -1;
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
  const validationDiagnostics = buildValidationDiagnostics(req, config);
  const { logContext: validationLogContext, signatureUrlCandidates } =
    validationDiagnostics;
  if (contentLength && Number(contentLength) > config.maxWebhookPayloadBytes) {
    log.warn(
      { contentLength, ...validationLogContext },
      "Twilio webhook payload too large",
    );
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  // Fail-closed: reject if no auth token is configured
  if (!config.twilioAuthToken) {
    log.error(
      validationLogContext,
      "Twilio auth token not configured — rejecting webhook (fail-closed)",
    );
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
    log.warn(
      { bodyLength: Buffer.byteLength(rawBody), ...validationLogContext },
      "Twilio webhook payload too large",
    );
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
    log.warn(
      validationLogContext,
      "Twilio webhook request missing X-Twilio-Signature header",
    );
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const signatureCandidateUrls = signatureUrlCandidates.map((c) => c.url);
  const validatingIndex = findValidatingCandidateIndex(
    signatureCandidateUrls,
    params,
    signature,
    config.twilioAuthToken!,
  );

  if (validatingIndex === -1) {
    log.warn(
      validationLogContext,
      "Twilio webhook signature validation failed",
    );
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const validatingCandidate = signatureUrlCandidates[validatingIndex];
  const successLogContext = {
    ...validationLogContext,
    validatedCandidateSource: validatingCandidate.source,
    validatedCandidateUrl: normalizeUrlForLog(validatingCandidate.url),
  };

  // When ingressPublicBaseUrl is configured and the signature only validated
  // against the raw local URL (last candidate), log a warning. This indicates
  // a likely drift between the configured ingress URL and the actual webhook
  // registration — the ingress URL should match what Twilio is signing against.
  if (
    config.ingressPublicBaseUrl &&
    validatingIndex === signatureCandidateUrls.length - 1 &&
    signatureCandidateUrls.length > 1
  ) {
    log.warn(
      {
        ...successLogContext,
        ingressPublicBaseUrl: config.ingressPublicBaseUrl,
      },
      "Twilio signature validated against raw request URL fallback — " +
        "INGRESS_PUBLIC_BASE_URL may be stale or mismatched with the actual webhook registration",
    );
  } else {
    log.info(successLogContext, "Twilio webhook signature validated");
  }

  return { rawBody, params };
}
