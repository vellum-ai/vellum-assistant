import type { ChannelId, InterfaceId } from "../channels/types.js";
import { mintIngressToken, mintServiceToken } from "../auth/token-exchange.js";
import type { GatewayConfig } from "../config.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("runtime-client");

// ── Circuit breaker ──────────────────────────────────────────────────

const enum CircuitState {
  CLOSED = 0,
  OPEN = 1,
  HALF_OPEN = 2,
}

const CB_FAILURE_THRESHOLD = 5;
const CB_COOLDOWN_MS = 30_000;

/**
 * Thrown when the circuit breaker is open. Callers should return 503
 * with a Retry-After header derived from `retryAfterSecs`.
 */
export class CircuitBreakerOpenError extends Error {
  readonly retryAfterSecs: number;
  constructor(retryAfterSecs: number) {
    super("Circuit breaker is open — runtime is unavailable");
    this.name = "CircuitBreakerOpenError";
    this.retryAfterSecs = retryAfterSecs;
  }
}

let cbState: CircuitState = CircuitState.CLOSED;
let cbConsecutiveFailures = 0;
let cbOpenedAt = 0;

function cbRetryAfterSecs(): number {
  const elapsed = Date.now() - cbOpenedAt;
  return Math.max(1, Math.ceil((CB_COOLDOWN_MS - elapsed) / 1000));
}

/**
 * Check the circuit before making a request. Throws if open.
 * Returns true when this is a half-open probe (caller must record outcome).
 */
function cbBeforeRequest(): boolean {
  if (cbState === CircuitState.CLOSED) return false;

  if (cbState === CircuitState.OPEN) {
    if (Date.now() - cbOpenedAt >= CB_COOLDOWN_MS) {
      cbState = CircuitState.HALF_OPEN;
      log.info("Circuit breaker entering HALF_OPEN — allowing probe request");
      return true;
    }
    throw new CircuitBreakerOpenError(cbRetryAfterSecs());
  }

  // HALF_OPEN: only one probe in flight; reject additional requests
  throw new CircuitBreakerOpenError(cbRetryAfterSecs());
}

function cbOnSuccess(): void {
  if (cbState !== CircuitState.CLOSED) {
    log.info("Circuit breaker closing — runtime recovered");
  }
  cbState = CircuitState.CLOSED;
  cbConsecutiveFailures = 0;
}

function cbOnFailure(): void {
  cbConsecutiveFailures++;

  if (cbState === CircuitState.HALF_OPEN) {
    cbState = CircuitState.OPEN;
    cbOpenedAt = Date.now();
    log.warn(
      { failures: cbConsecutiveFailures },
      "Circuit breaker re-opening after failed probe",
    );
    return;
  }

  if (cbConsecutiveFailures >= CB_FAILURE_THRESHOLD) {
    cbState = CircuitState.OPEN;
    cbOpenedAt = Date.now();
    log.warn(
      { failures: cbConsecutiveFailures },
      "Circuit breaker opening — runtime appears down",
    );
  }
}

/**
 * Build common headers for runtime requests using JWT auth.
 *
 * Mints a short-lived token (aud=vellum-daemon) per-request. The token
 * itself proves gateway origin — only the gateway holds the signing key
 * needed to mint daemon-audience tokens. No separate origin header needed.
 */
function runtimeIngressHeaders(
  config: GatewayConfig,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  headers["Authorization"] = `Bearer ${mintIngressToken()}`;
  return headers;
}

function runtimeServiceHeaders(
  config: GatewayConfig,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  headers["Authorization"] = `Bearer ${mintServiceToken()}`;
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
  sourceChannel: ChannelId;
  /** Explicit interface identifier forwarded to the assistant. */
  interface: InterfaceId;
  conversationExternalId: string;
  externalMessageId: string;
  content: string;
  isEdit?: boolean;
  callbackQueryId?: string;
  callbackData?: string;
  actorDisplayName?: string;
  actorExternalId: string;
  actorUsername?: string;
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
  data?: string; // base64-encoded; absent for file-backed attachments until hydrated
  fileBacked?: boolean;
};

/** Attachment payload after hydration — `data` is guaranteed present. */
export type HydratedAttachmentPayload = RuntimeAttachmentPayload & {
  data: string;
};

export type RuntimeInboundResponse = {
  accepted: boolean;
  duplicate: boolean;
  eventId: string;
  approval?:
    | "decision_applied"
    | "assistant_turn"
    | "guardian_decision_applied"
    | "stale_ignored";
  assistantMessage?: {
    id: string;
    role: "assistant";
    content: string;
    timestamp: string;
    attachments: RuntimeAttachmentMeta[];
  };
  /** When true, the runtime denied the inbound message (e.g. ACL rejection). */
  denied?: boolean;
  /**
   * A user-facing rejection message that the runtime could not deliver via
   * the callback URL (e.g. due to auth failure). When present, the gateway
   * should deliver it directly to the channel.
   */
  replyText?: string;
};

export type ForwardOptions = {
  traceId?: string;
};

export async function forwardToRuntime(
  config: GatewayConfig,
  payload: RuntimeInboundPayload,
  options?: ForwardOptions,
): Promise<RuntimeInboundResponse> {
  const isHalfOpenProbe = cbBeforeRequest();

  const url = `${config.assistantRuntimeBaseUrl}/v1/channels/inbound`;

  const extraHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options?.traceId) {
    extraHeaders["X-Trace-Id"] = options.traceId;
  }

  let lastError: Error | null = null;

  // Half-open probes get a single attempt — retries would defeat the
  // purpose of cautiously testing whether the runtime has recovered.
  const maxRetries = isHalfOpenProbe ? 0 : config.runtimeMaxRetries;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = config.runtimeInitialBackoffMs * Math.pow(2, attempt - 1);
      log.debug({ attempt, delay }, "Retrying runtime forward");
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: runtimeIngressHeaders(config, extraHeaders),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.runtimeTimeoutMs),
      });

      if (response.status >= 400 && response.status < 500) {
        const body = await response.text();
        log.warn(
          { status: response.status, body },
          "Runtime returned client error, not retrying",
        );
        // 4xx = client error, not a daemon outage — don't trip the breaker
        cbOnSuccess();
        throw new Error(`Runtime returned ${response.status}: ${body}`);
      }

      if (response.status >= 500) {
        const body = await response.text();
        lastError = new Error(`Runtime returned ${response.status}: ${body}`);
        log.warn(
          { status: response.status, attempt },
          "Runtime returned server error",
        );
        continue;
      }

      const result = (await response.json()) as RuntimeInboundResponse;
      log.debug(
        { eventId: result.eventId, duplicate: result.duplicate },
        "Runtime forward succeeded",
      );
      cbOnSuccess();
      return result;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith("Runtime returned 4")
      ) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn({ err: lastError, attempt }, "Runtime forward attempt failed");
    }
  }

  cbOnFailure();
  throw lastError ?? new Error("Runtime forward failed after retries");
}

export async function resetConversation(
  config: GatewayConfig,
  sourceChannel: ChannelId,
  conversationExternalId: string,
): Promise<void> {
  cbBeforeRequest();

  const url = `${config.assistantRuntimeBaseUrl}/v1/channels/conversation`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "DELETE",
      headers: runtimeServiceHeaders(config, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ sourceChannel, conversationExternalId }),
      signal: AbortSignal.timeout(config.runtimeTimeoutMs),
    });
  } catch (err) {
    cbOnFailure();
    throw err;
  }

  if (!response.ok) {
    const body = await response.text();
    if (response.status >= 500) cbOnFailure();
    else cbOnSuccess();
    throw new Error(`Reset conversation failed (${response.status}): ${body}`);
  }

  cbOnSuccess();
}

export type UploadAttachmentInput = {
  filename: string;
  mimeType: string;
  data: string; // base64-encoded
};

export type UploadAttachmentResponse = {
  id: string;
};

/**
 * Internal helper that fetches raw attachment content without interacting
 * with the circuit breaker. Used by downloadAttachment's hydration path
 * which already owns the breaker lifecycle for the compound operation.
 */
async function fetchAttachmentContentRaw(
  config: GatewayConfig,
  attachmentId: string,
): Promise<Buffer> {
  const url = `${
    config.assistantRuntimeBaseUrl
  }/v1/attachments/${encodeURIComponent(attachmentId)}/content`;

  const response = await fetchImpl(url, {
    method: "GET",
    headers: runtimeServiceHeaders(config),
    signal: AbortSignal.timeout(config.runtimeTimeoutMs),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Attachment content download failed (${response.status}): ${body}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function downloadAttachmentContent(
  config: GatewayConfig,
  attachmentId: string,
): Promise<Buffer> {
  cbBeforeRequest();

  try {
    const buffer = await fetchAttachmentContentRaw(config, attachmentId);
    cbOnSuccess();
    return buffer;
  } catch (err) {
    cbOnFailure();
    throw err;
  }
}

export async function downloadAttachment(
  config: GatewayConfig,
  attachmentId: string,
): Promise<HydratedAttachmentPayload> {
  cbBeforeRequest();

  const url = `${
    config.assistantRuntimeBaseUrl
  }/v1/attachments/${encodeURIComponent(attachmentId)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: runtimeServiceHeaders(config),
      signal: AbortSignal.timeout(config.runtimeTimeoutMs),
    });
  } catch (err) {
    cbOnFailure();
    throw err;
  }

  if (!response.ok) {
    const body = await response.text();
    if (response.status >= 500) cbOnFailure();
    else cbOnSuccess();
    throw new Error(`Attachment download failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as RuntimeAttachmentPayload;

  // Transparently hydrate file-backed attachments: fetch the binary content
  // from the dedicated /content endpoint and inline it as base64.
  // We use the raw helper (no nested circuit breaker) so the compound
  // metadata+content operation is treated as a single breaker unit.
  // If content fetch fails, cbOnFailure() fires for the whole operation.
  if (payload.fileBacked && payload.data == null) {
    try {
      const contentBuffer = await fetchAttachmentContentRaw(
        config,
        attachmentId,
      );
      payload.data = contentBuffer.toString("base64");
    } catch (err) {
      cbOnFailure();
      throw err;
    }
  }

  // Use == null to allow empty string (valid base64 for zero-byte attachments)
  if (payload.data == null) {
    throw new Error(`Attachment ${attachmentId} has no data after hydration`);
  }

  cbOnSuccess();
  return payload as HydratedAttachmentPayload;
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
 *
 * For inbound calls, `assistantId` is resolved by the gateway from the "To"
 * phone number and forwarded so the runtime knows which assistant to bootstrap.
 */
export async function forwardTwilioVoiceWebhook(
  config: GatewayConfig,
  params: Record<string, string>,
  originalUrl: string,
): Promise<TwilioForwardResponse> {
  cbBeforeRequest();

  const url = `${config.assistantRuntimeBaseUrl}/v1/internal/twilio/voice-webhook`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: runtimeServiceHeaders(config, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ params, originalUrl }),
      signal: AbortSignal.timeout(config.runtimeTimeoutMs),
    });
  } catch (err) {
    cbOnFailure();
    throw err;
  }

  const body = await response.text();
  const headers: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  if (response.status >= 500) cbOnFailure();
  else cbOnSuccess();
  return { status: response.status, body, headers };
}

/**
 * Forward a validated Twilio status callback payload to the runtime.
 */
export async function forwardTwilioStatusWebhook(
  config: GatewayConfig,
  params: Record<string, string>,
): Promise<TwilioForwardResponse> {
  cbBeforeRequest();

  const url = `${config.assistantRuntimeBaseUrl}/v1/internal/twilio/status`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: runtimeServiceHeaders(config, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ params }),
      signal: AbortSignal.timeout(config.runtimeTimeoutMs),
    });
  } catch (err) {
    cbOnFailure();
    throw err;
  }

  const body = await response.text();
  const headers: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  if (response.status >= 500) cbOnFailure();
  else cbOnSuccess();
  return { status: response.status, body, headers };
}

/**
 * Forward a validated Twilio connect-action callback payload to the runtime.
 */
export async function forwardTwilioConnectActionWebhook(
  config: GatewayConfig,
  params: Record<string, string>,
): Promise<TwilioForwardResponse> {
  cbBeforeRequest();

  const url = `${config.assistantRuntimeBaseUrl}/v1/internal/twilio/connect-action`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: runtimeServiceHeaders(config, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ params }),
      signal: AbortSignal.timeout(config.runtimeTimeoutMs),
    });
  } catch (err) {
    cbOnFailure();
    throw err;
  }

  const body = await response.text();
  const headers: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  if (response.status >= 500) cbOnFailure();
  else cbOnSuccess();
  return { status: response.status, body, headers };
}

/**
 * Forward a validated Twilio SMS webhook payload to the runtime.
 */
export async function forwardTwilioSmsWebhook(
  config: GatewayConfig,
  params: Record<string, string>,
): Promise<TwilioForwardResponse> {
  cbBeforeRequest();

  const url = `${config.assistantRuntimeBaseUrl}/v1/internal/twilio/sms`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: runtimeServiceHeaders(config, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ params }),
      signal: AbortSignal.timeout(config.runtimeTimeoutMs),
    });
  } catch (err) {
    cbOnFailure();
    throw err;
  }

  const body = await response.text();
  const headers: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  if (response.status >= 500) cbOnFailure();
  else cbOnSuccess();
  return { status: response.status, body, headers };
}

export async function uploadAttachment(
  config: GatewayConfig,
  input: UploadAttachmentInput,
  opts?: { skipCircuitBreaker?: boolean },
): Promise<UploadAttachmentResponse> {
  const skipCb = opts?.skipCircuitBreaker === true;

  // Always check the breaker for fail-fast (OPEN/HALF_OPEN rejection).
  // skipCb only suppresses success/failure accounting so attachment errors
  // don't trip the breaker — but half-open probes must always record their
  // outcome to avoid getting stuck in HALF_OPEN permanently.
  const isProbe = cbBeforeRequest();
  const recordOutcome = !skipCb || isProbe;

  const url = `${config.assistantRuntimeBaseUrl}/v1/attachments`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: runtimeServiceHeaders(config, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(config.runtimeTimeoutMs),
    });
  } catch (err) {
    if (recordOutcome) cbOnFailure();
    throw err;
  }

  if (!response.ok) {
    const body = await response.text();
    // 4xx = non-retriable validation rejection (unsupported MIME, dangerous
    // extension, missing fields). Distinguish from transient 5xx/network errors
    // so callers can decide whether to skip or propagate.
    if (response.status >= 400 && response.status < 500) {
      if (recordOutcome) cbOnSuccess();
      throw new AttachmentValidationError(
        `Attachment rejected (${response.status}): ${body}`,
      );
    }
    if (recordOutcome) cbOnFailure();
    throw new Error(`Attachment upload failed (${response.status}): ${body}`);
  }

  if (recordOutcome) cbOnSuccess();
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
  cbBeforeRequest();

  const url = `${config.assistantRuntimeBaseUrl}/v1/internal/oauth/callback`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: runtimeServiceHeaders(config, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ state, code, error }),
      signal: AbortSignal.timeout(config.runtimeTimeoutMs),
    });
  } catch (err) {
    cbOnFailure();
    throw err;
  }

  const body = await response.text();
  if (response.status >= 500) cbOnFailure();
  else cbOnSuccess();
  return { status: response.status, body };
}
