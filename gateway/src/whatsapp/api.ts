import type { CredentialCache } from "../credential-cache.js";
import type { GatewayConfig } from "../config.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("whatsapp-api");

export class WhatsAppNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppNonRetryableError";
  }
}

// Meta Cloud API v20 endpoint template
const WHATSAPP_API_BASE = "https://graph.facebook.com/v20.0";

interface WhatsAppApiErrorDetail {
  message?: string;
  type?: string;
  code?: number;
  fbtrace_id?: string;
}

interface WhatsAppApiErrorResponse {
  error?: WhatsAppApiErrorDetail;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

// Auth/permission errors are transient — a token rotation or permission fix
// can resolve them within Meta's retry window. These should NOT be treated as
// non-retryable so the webhook returns 500 and Meta retries the delivery.
function isAuthError(status: number): boolean {
  return status === 401 || status === 403;
}

function computeDelay(
  attempt: number,
  initialBackoffMs: number,
  retryAfterHeader: string | null,
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 2_147_483_647);
    }
    const targetTime = new Date(retryAfterHeader).getTime();
    if (Number.isFinite(targetTime)) {
      const delayMs = targetTime - Date.now();
      if (delayMs > 0) {
        return Math.min(delayMs, 2_147_483_647);
      }
    }
  }

  const exponential = initialBackoffMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * exponential * 0.5;
  return exponential + jitter;
}

async function retryableWhatsAppFetch<T>(
  config: GatewayConfig,
  operation: string,
  doFetch: () => Promise<Response>,
): Promise<T> {
  let lastError: Error | null = null;
  let lastRetryAfter: string | null = null;

  for (let attempt = 0; attempt <= config.whatsappMaxRetries; attempt++) {
    if (attempt > 0) {
      const delay = computeDelay(
        attempt,
        config.whatsappInitialBackoffMs,
        lastRetryAfter,
      );
      log.debug({ attempt, delay, operation }, "Retrying WhatsApp API call");
      await new Promise((r) => setTimeout(r, delay));
    }

    lastRetryAfter = null;

    let response: Response;
    try {
      response = await doFetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = new Error(`WhatsApp ${operation} request failed: ${message}`);
      log.warn(
        { error: message, attempt, operation },
        "WhatsApp API fetch failed",
      );
      continue;
    }

    if (!isRetryable(response.status) && !response.ok) {
      const data = (await response
        .json()
        .catch(() => ({}))) as WhatsAppApiErrorResponse;
      const message = data.error?.message
        ? `WhatsApp ${operation} failed: ${data.error.message}`
        : `WhatsApp ${operation} failed with status ${response.status}`;

      // Auth/permission errors (401/403) are transient — propagate as regular
      // errors so the webhook returns 500 and Meta retries within its window.
      // Other 4xx errors (400 invalid media, 404 expired) are terminal.
      if (isAuthError(response.status)) {
        throw new Error(message);
      }
      throw new WhatsAppNonRetryableError(message);
    }

    if (isRetryable(response.status)) {
      lastRetryAfter = response.headers.get("retry-after");
      const data = (await response
        .json()
        .catch(() => ({}))) as WhatsAppApiErrorResponse;
      lastError = new Error(
        data.error?.message
          ? `WhatsApp ${operation} failed: ${data.error.message}`
          : `WhatsApp ${operation} failed with status ${response.status}`,
      );
      log.warn(
        {
          status: response.status,
          attempt,
          operation,
          retryAfter: lastRetryAfter,
        },
        "WhatsApp API returned retryable error",
      );
      continue;
    }

    return (await response.json()) as T;
  }

  throw lastError ?? new Error(`WhatsApp ${operation} failed after retries`);
}

/** Options bag for optional credential cache injection into WhatsApp API calls. */
export type WhatsAppApiCaches = {
  credentials?: CredentialCache;
};

/**
 * Resolve WhatsApp credentials from cache (preferred) or config (fallback).
 * Returns undefined fields if neither source has the value.
 */
async function resolveWhatsAppCredentials(
  config: GatewayConfig,
  caches?: WhatsAppApiCaches,
): Promise<{
  phoneNumberId: string | undefined;
  accessToken: string | undefined;
}> {
  let phoneNumberId: string | undefined;
  let accessToken: string | undefined;
  if (caches?.credentials) {
    phoneNumberId = await caches.credentials.get(
      "credential:whatsapp:phone_number_id",
    );
    accessToken = await caches.credentials.get(
      "credential:whatsapp:access_token",
    );
  }
  phoneNumberId ??= config.whatsappPhoneNumberId;
  accessToken ??= config.whatsappAccessToken;
  return { phoneNumberId, accessToken };
}

export interface WhatsAppSendMessageResult {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

/**
 * Send a text message via the WhatsApp Business Cloud API.
 * phoneNumberId is the WhatsApp Business phone number ID (not the phone number itself).
 */
export async function sendWhatsAppTextMessage(
  config: GatewayConfig,
  to: string,
  text: string,
  caches?: WhatsAppApiCaches,
): Promise<WhatsAppSendMessageResult> {
  const { phoneNumberId, accessToken } = await resolveWhatsAppCredentials(
    config,
    caches,
  );
  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }

  return retryableWhatsAppFetch<WhatsAppSendMessageResult>(
    config,
    "sendMessage",
    () =>
      fetchImpl(`${WHATSAPP_API_BASE}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { body: text, preview_url: false },
        }),
        signal: AbortSignal.timeout(config.whatsappTimeoutMs),
      }),
  );
}

export interface WhatsAppMediaUploadResult {
  id: string;
}

/**
 * Upload media to WhatsApp Business Cloud API and get a reusable media ID.
 * The media ID can then be used in sendWhatsAppMediaMessage.
 */
export async function uploadWhatsAppMedia(
  config: GatewayConfig,
  blob: Blob,
  filename: string,
  mimeType: string,
  caches?: WhatsAppApiCaches,
): Promise<WhatsAppMediaUploadResult> {
  const { phoneNumberId, accessToken } = await resolveWhatsAppCredentials(
    config,
    caches,
  );
  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }

  return retryableWhatsAppFetch<WhatsAppMediaUploadResult>(
    config,
    "uploadMedia",
    () => {
      const form = new FormData();
      form.set("messaging_product", "whatsapp");
      form.set("file", blob, filename);
      form.set("type", mimeType);

      return fetchImpl(`${WHATSAPP_API_BASE}/${phoneNumberId}/media`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: form,
        signal: AbortSignal.timeout(config.whatsappTimeoutMs),
      });
    },
  );
}

export type WhatsAppMediaType = "image" | "video" | "document";

/**
 * Send a media message via the WhatsApp Business Cloud API.
 * Requires a previously uploaded media ID from uploadWhatsAppMedia.
 */
export async function sendWhatsAppMediaMessage(
  config: GatewayConfig,
  to: string,
  mediaType: WhatsAppMediaType,
  mediaId: string,
  filename?: string,
  caption?: string,
  caches?: WhatsAppApiCaches,
): Promise<WhatsAppSendMessageResult> {
  const { phoneNumberId, accessToken } = await resolveWhatsAppCredentials(
    config,
    caches,
  );
  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }

  const mediaPayload: Record<string, unknown> = { id: mediaId };
  if (caption) mediaPayload.caption = caption;
  // WhatsApp only supports filename on document type
  if (mediaType === "document" && filename) mediaPayload.filename = filename;

  return retryableWhatsAppFetch<WhatsAppSendMessageResult>(
    config,
    "sendMediaMessage",
    () =>
      fetchImpl(`${WHATSAPP_API_BASE}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: mediaType,
          [mediaType]: mediaPayload,
        }),
        signal: AbortSignal.timeout(config.whatsappTimeoutMs),
      }),
  );
}

/**
 * Send an interactive button message via the WhatsApp Business Cloud API.
 * Used for approval prompts where the user can tap a button to respond.
 * WhatsApp supports up to 3 reply buttons per interactive message.
 */
export async function sendWhatsAppInteractiveMessage(
  config: GatewayConfig,
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
  caches?: WhatsAppApiCaches,
): Promise<WhatsAppSendMessageResult> {
  const { phoneNumberId, accessToken } = await resolveWhatsAppCredentials(
    config,
    caches,
  );
  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }

  return retryableWhatsAppFetch<WhatsAppSendMessageResult>(
    config,
    "sendInteractiveMessage",
    () =>
      fetchImpl(`${WHATSAPP_API_BASE}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: bodyText },
            action: {
              buttons: buttons.map((b) => ({
                type: "reply",
                reply: { id: b.id, title: b.title },
              })),
            },
          },
        }),
        signal: AbortSignal.timeout(config.whatsappTimeoutMs),
      }),
  );
}

/** Metadata returned by the WhatsApp media endpoint. */
export interface WhatsAppMediaMetadata {
  url: string;
  mime_type: string;
  sha256: string;
  file_size: number;
  id: string;
}

/**
 * Resolve media metadata (download URL, MIME type, size) from a WhatsApp media ID.
 * The returned URL is short-lived and requires the access token as a Bearer header.
 */
export async function getWhatsAppMediaMetadata(
  config: GatewayConfig,
  mediaId: string,
  caches?: WhatsAppApiCaches,
): Promise<WhatsAppMediaMetadata> {
  const { accessToken } = await resolveWhatsAppCredentials(config, caches);
  if (!accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }

  return retryableWhatsAppFetch<WhatsAppMediaMetadata>(
    config,
    "getMediaMetadata",
    () =>
      fetchImpl(`${WHATSAPP_API_BASE}/${mediaId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(config.whatsappTimeoutMs),
      }),
  );
}

/**
 * Download the raw bytes of a WhatsApp media object given its CDN URL.
 * The URL comes from getWhatsAppMediaMetadata and requires the access token.
 * Returns the raw Response so callers can stream or buffer as needed.
 */
export async function downloadWhatsAppMediaBytes(
  config: GatewayConfig,
  mediaUrl: string,
  caches?: WhatsAppApiCaches,
): Promise<Response> {
  const { accessToken } = await resolveWhatsAppCredentials(config, caches);
  if (!accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }

  return retryableWhatsAppRawFetch(config, "downloadMedia", () =>
    fetchImpl(mediaUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(config.whatsappTimeoutMs),
    }),
  );
}

/**
 * Like retryableWhatsAppFetch but returns the raw Response instead of parsing JSON.
 * Used for binary downloads where the response body is not JSON.
 */
async function retryableWhatsAppRawFetch(
  config: GatewayConfig,
  operation: string,
  doFetch: () => Promise<Response>,
): Promise<Response> {
  let lastError: Error | null = null;
  let lastRetryAfter: string | null = null;

  for (let attempt = 0; attempt <= config.whatsappMaxRetries; attempt++) {
    if (attempt > 0) {
      const delay = computeDelay(
        attempt,
        config.whatsappInitialBackoffMs,
        lastRetryAfter,
      );
      log.debug({ attempt, delay, operation }, "Retrying WhatsApp API call");
      await new Promise((r) => setTimeout(r, delay));
    }

    lastRetryAfter = null;

    let response: Response;
    try {
      response = await doFetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = new Error(`WhatsApp ${operation} request failed: ${message}`);
      log.warn(
        { error: message, attempt, operation },
        "WhatsApp API fetch failed",
      );
      continue;
    }

    if (!isRetryable(response.status) && !response.ok) {
      const body = await response.text().catch(() => "");
      let errorMessage: string | undefined;
      try {
        const data = JSON.parse(body) as WhatsAppApiErrorResponse;
        errorMessage = data.error?.message;
      } catch {
        // Response body is not JSON — include raw text if available
      }
      const message = errorMessage
        ? `WhatsApp ${operation} failed: ${errorMessage}`
        : body
          ? `WhatsApp ${operation} failed with status ${response.status}: ${body}`
          : `WhatsApp ${operation} failed with status ${response.status}`;

      if (isAuthError(response.status)) {
        throw new Error(message);
      }
      throw new WhatsAppNonRetryableError(message);
    }

    if (isRetryable(response.status)) {
      lastRetryAfter = response.headers.get("retry-after");
      const body = await response.text().catch(() => "");
      let errorMessage: string | undefined;
      try {
        const data = JSON.parse(body) as WhatsAppApiErrorResponse;
        errorMessage = data.error?.message;
      } catch {
        // Response body is not JSON
      }
      lastError = new Error(
        errorMessage
          ? `WhatsApp ${operation} failed: ${errorMessage}`
          : `WhatsApp ${operation} failed with status ${response.status}`,
      );
      log.warn(
        {
          status: response.status,
          attempt,
          operation,
          retryAfter: lastRetryAfter,
        },
        "WhatsApp API returned retryable error",
      );
      continue;
    }

    return response;
  }

  throw lastError ?? new Error(`WhatsApp ${operation} failed after retries`);
}

/**
 * Mark an incoming WhatsApp message as read.
 * Best-effort — callers should not propagate errors from this.
 */
export async function markWhatsAppMessageRead(
  config: GatewayConfig,
  messageId: string,
  caches?: WhatsAppApiCaches,
): Promise<void> {
  const { phoneNumberId, accessToken } = await resolveWhatsAppCredentials(
    config,
    caches,
  );
  if (!phoneNumberId || !accessToken) return;

  try {
    await fetchImpl(`${WHATSAPP_API_BASE}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
      signal: AbortSignal.timeout(config.whatsappTimeoutMs),
    });
  } catch (err) {
    log.debug({ err, messageId }, "Failed to mark WhatsApp message as read");
  }
}
