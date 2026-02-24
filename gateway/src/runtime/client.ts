import type { GatewayConfig } from "../config.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("runtime-client");

/**
 * Header name used to prove a request originated from the gateway.
 * The value is the dedicated gateway-origin secret (or the bearer token as
 * fallback). The runtime validates it to reject direct calls that bypass
 * the gateway's webhook-level verification.
 */
export const GATEWAY_ORIGIN_HEADER = "X-Gateway-Origin";

/** Build common headers for runtime requests, including auth when configured. */
function runtimeHeaders(config: GatewayConfig, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (config.runtimeBearerToken) {
    headers["Authorization"] = `Bearer ${config.runtimeBearerToken}`;
  }
  // Attach gateway-origin proof using the dedicated secret. When
  // RUNTIME_GATEWAY_ORIGIN_SECRET is not set, this falls back to
  // runtimeBearerToken via the config layer.
  if (config.runtimeGatewayOriginSecret) {
    headers[GATEWAY_ORIGIN_HEADER] = config.runtimeGatewayOriginSecret;
  }
  return headers;
}

/**
 * Thrown when the assistant rejects an attachment for a non-retriable reason
 * (e.g. unsupported MIME type, dangerous file extension). Callers can use
 * this to distinguish validation failures from transient errors.
 */
export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

export type RuntimeInboundPayload = {
  sourceChannel: string;
  externalChatId: string;
  externalMessageId: string;
  content: string;
  isEdit?: boolean;
  callbackQueryId?: string;
  callbackData?: string;
  senderName?: string;
  senderExternalUserId?: string;
  senderUsername?: string;
  sourceMetadata?: Record<string, unknown>;
  attachmentIds?: string[];
  replyCallbackUrl?: string;
};

export type RuntimeAttachmentMeta = {
  id: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  kind?: string;
};

export type RuntimeAttachmentPayload = RuntimeAttachmentMeta & {
  data: string; // base64-encoded
};

export type RuntimeInboundResponse = {
  accepted: boolean;
  duplicate: boolean;
  eventId: string;
  approval?: "decision_applied" | "reminder_sent" | "guardian_decision_applied" | "stale_ignored";
  assistantMessage?: {
    id: string;
    role: "assistant";
    content: string;
    timestamp: string;
    attachments: RuntimeAttachmentMeta[];
  };
};

export type ForwardOptions = {
  traceId?: string;
};

export async function forwardToRuntime(
  config: GatewayConfig,
  assistantId: string,
  payload: RuntimeInboundPayload,
  options?: ForwardOptions,
): Promise<RuntimeInboundResponse> {
  const url = `${config.assistantRuntimeBaseUrl}/v1/assistants/${encodeURIComponent(assistantId)}/channels/inbound`;

  const extraHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (options?.traceId) {
    extraHeaders["X-Trace-Id"] = options.traceId;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.runtimeMaxRetries; attempt++) {
    if (attempt > 0) {
      const delay = config.runtimeInitialBackoffMs * Math.pow(2, attempt - 1);
      log.debug({ attempt, delay, assistantId }, "Retrying runtime forward");
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: runtimeHeaders(config, extraHeaders),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.runtimeTimeoutMs),
      });

      if (response.status >= 400 && response.status < 500) {
        const body = await response.text();
        log.warn(
          { status: response.status, body, assistantId },
          "Runtime returned client error, not retrying",
        );
        throw new Error(`Runtime returned ${response.status}: ${body}`);
      }

      if (response.status >= 500) {
        const body = await response.text();
        lastError = new Error(`Runtime returned ${response.status}: ${body}`);
        log.warn(
          { status: response.status, attempt, assistantId },
          "Runtime returned server error",
        );
        continue;
      }

      const result = (await response.json()) as RuntimeInboundResponse;
      log.debug(
        { assistantId, eventId: result.eventId, duplicate: result.duplicate },
        "Runtime forward succeeded",
      );
      return result;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith("Runtime returned 4")
      ) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn(
        { err: lastError, attempt, assistantId },
        "Runtime forward attempt failed",
      );
    }
  }

  throw lastError ?? new Error("Runtime forward failed after retries");
}

export async function resetConversation(
  config: GatewayConfig,
  assistantId: string,
  sourceChannel: string,
  externalChatId: string,
): Promise<void> {
  const url = `${config.assistantRuntimeBaseUrl}/v1/assistants/${encodeURIComponent(assistantId)}/channels/conversation`;

  const response = await fetchImpl(url, {
    method: "DELETE",
    headers: runtimeHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify({ sourceChannel, externalChatId }),
    signal: AbortSignal.timeout(config.runtimeTimeoutMs),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Reset conversation failed (${response.status}): ${body}`);
  }
}

export type UploadAttachmentInput = {
  filename: string;
  mimeType: string;
  data: string; // base64-encoded
};

export type UploadAttachmentResponse = {
  id: string;
};

export async function downloadAttachment(
  config: GatewayConfig,
  assistantId: string,
  attachmentId: string,
): Promise<RuntimeAttachmentPayload> {
  const url = `${config.assistantRuntimeBaseUrl}/v1/assistants/${encodeURIComponent(assistantId)}/attachments/${encodeURIComponent(attachmentId)}`;

  const response = await fetchImpl(url, {
    method: "GET",
    headers: runtimeHeaders(config),
    signal: AbortSignal.timeout(config.runtimeTimeoutMs),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Attachment download failed (${response.status}): ${body}`);
  }

  return (await response.json()) as RuntimeAttachmentPayload;
}

/**
 * Download an attachment without requiring an assistantId.
 * Uses the assistant-less /v1/attachments/:attachmentId endpoint.
 */
export async function downloadAttachmentById(
  config: GatewayConfig,
  attachmentId: string,
): Promise<RuntimeAttachmentPayload> {
  const url = `${config.assistantRuntimeBaseUrl}/v1/attachments/${encodeURIComponent(attachmentId)}`;

  const response = await fetchImpl(url, {
    method: "GET",
    headers: runtimeHeaders(config),
    signal: AbortSignal.timeout(config.runtimeTimeoutMs),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Attachment download failed (${response.status}): ${body}`);
  }

  return (await response.json()) as RuntimeAttachmentPayload;
}

// ── Twilio webhook forwarding ────────────────────────────────────────

export type TwilioForwardResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

/**
 * Forward a validated Twilio voice webhook payload to the runtime.
 * The gateway sends the parsed form params as JSON; the runtime's internal
 * endpoint reconstructs what it needs.
 */
export async function forwardTwilioVoiceWebhook(
  config: GatewayConfig,
  params: Record<string, string>,
  originalUrl: string,
): Promise<TwilioForwardResponse> {
  const url = `${config.assistantRuntimeBaseUrl}/v1/internal/twilio/voice-webhook`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: runtimeHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify({ params, originalUrl }),
    signal: AbortSignal.timeout(config.runtimeTimeoutMs),
  });

  const body = await response.text();
  const headers: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  return { status: response.status, body, headers };
}

/**
 * Forward a validated Twilio status callback payload to the runtime.
 */
export async function forwardTwilioStatusWebhook(
  config: GatewayConfig,
  params: Record<string, string>,
): Promise<TwilioForwardResponse> {
  const url = `${config.assistantRuntimeBaseUrl}/v1/internal/twilio/status`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: runtimeHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify({ params }),
    signal: AbortSignal.timeout(config.runtimeTimeoutMs),
  });

  const body = await response.text();
  const headers: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  return { status: response.status, body, headers };
}

/**
 * Forward a validated Twilio connect-action callback payload to the runtime.
 */
export async function forwardTwilioConnectActionWebhook(
  config: GatewayConfig,
  params: Record<string, string>,
): Promise<TwilioForwardResponse> {
  const url = `${config.assistantRuntimeBaseUrl}/v1/internal/twilio/connect-action`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: runtimeHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify({ params }),
    signal: AbortSignal.timeout(config.runtimeTimeoutMs),
  });

  const body = await response.text();
  const headers: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  return { status: response.status, body, headers };
}

export async function uploadAttachment(
  config: GatewayConfig,
  assistantId: string,
  input: UploadAttachmentInput,
): Promise<UploadAttachmentResponse> {
  const url = `${config.assistantRuntimeBaseUrl}/v1/assistants/${encodeURIComponent(assistantId)}/attachments`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: runtimeHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(config.runtimeTimeoutMs),
  });

  if (!response.ok) {
    const body = await response.text();
    // 4xx = non-retriable validation rejection (unsupported MIME, dangerous
    // extension, missing fields). Distinguish from transient 5xx/network errors
    // so callers can decide whether to skip or propagate.
    if (response.status >= 400 && response.status < 500) {
      throw new AttachmentValidationError(
        `Attachment rejected (${response.status}): ${body}`,
      );
    }
    throw new Error(`Attachment upload failed (${response.status}): ${body}`);
  }

  return (await response.json()) as UploadAttachmentResponse;
}

// ── OAuth callback forwarding ────────────────────────────────────────

export type OAuthCallbackResponse = {
  status: number;
  body: string;
};

/**
 * Forward an OAuth callback to the runtime's internal endpoint.
 * This is a one-shot operation — no retries, since the state token
 * can only be consumed once.
 */
export async function forwardOAuthCallback(
  config: GatewayConfig,
  state: string,
  code?: string,
  error?: string,
): Promise<OAuthCallbackResponse> {
  const url = `${config.assistantRuntimeBaseUrl}/v1/internal/oauth/callback`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: runtimeHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify({ state, code, error }),
    signal: AbortSignal.timeout(config.runtimeTimeoutMs),
  });

  const body = await response.text();
  return { status: response.status, body };
}
