/**
 * WhatsApp Business Cloud API client for direct outbound messaging.
 *
 * Calls the Meta Cloud API directly using credentials from the secure store,
 * eliminating the gateway HTTP proxy hop. Retry logic, error classification,
 * and payload shapes mirror the gateway's whatsapp/api.ts so behavior is
 * identical.
 */

import { credentialKey } from "../../../security/credential-key.js";
import { getSecureKeyAsync } from "../../../security/secure-keys.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("whatsapp-api");

// Meta Cloud API v20 endpoint template
const WHATSAPP_API_BASE = "https://graph.facebook.com/v20.0";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class WhatsAppNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppNonRetryableError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
      if (delayMs > 0) return Math.min(delayMs, 2_147_483_647);
    }
  }
  const exponential = initialBackoffMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * exponential * 0.5;
  return exponential + jitter;
}

async function retryableFetch<T>(
  operation: string,
  doFetch: () => Promise<Response>,
): Promise<T> {
  let lastError: Error | null = null;
  let lastRetryAfter: string | null = null;

  for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = computeDelay(
        attempt,
        DEFAULT_INITIAL_BACKOFF_MS,
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
        // not JSON
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
        // not JSON
      }
      lastError = new Error(
        errorMessage
          ? `WhatsApp ${operation} failed: ${errorMessage}`
          : body
            ? `WhatsApp ${operation} failed with status ${response.status}: ${body}`
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

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

async function resolveCredentials(): Promise<{
  phoneNumberId: string;
  accessToken: string;
}> {
  const phoneNumberId = await getSecureKeyAsync(
    credentialKey("whatsapp", "phone_number_id"),
  );
  const accessToken = await getSecureKeyAsync(
    credentialKey("whatsapp", "access_token"),
  );
  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }
  return { phoneNumberId, accessToken };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WhatsAppSendMessageResult {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

export async function sendWhatsAppTextMessage(
  to: string,
  text: string,
): Promise<WhatsAppSendMessageResult> {
  const { phoneNumberId, accessToken } = await resolveCredentials();

  return retryableFetch<WhatsAppSendMessageResult>("sendMessage", () =>
    fetch(`${WHATSAPP_API_BASE}/${phoneNumberId}/messages`, {
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
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    }),
  );
}

export interface WhatsAppMediaUploadResult {
  id: string;
}

export async function uploadWhatsAppMedia(
  blob: Blob,
  filename: string,
  mimeType: string,
): Promise<WhatsAppMediaUploadResult> {
  const { phoneNumberId, accessToken } = await resolveCredentials();

  return retryableFetch<WhatsAppMediaUploadResult>("uploadMedia", () => {
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("file", blob, filename);
    form.set("type", mimeType);

    return fetch(`${WHATSAPP_API_BASE}/${phoneNumberId}/media`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: form,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  });
}

export type WhatsAppMediaType = "image" | "video" | "document";

export async function sendWhatsAppMediaMessage(
  to: string,
  mediaType: WhatsAppMediaType,
  mediaId: string,
  filename?: string,
  caption?: string,
): Promise<WhatsAppSendMessageResult> {
  const { phoneNumberId, accessToken } = await resolveCredentials();

  const mediaPayload: Record<string, unknown> = { id: mediaId };
  if (caption) mediaPayload.caption = caption;
  if (mediaType === "document" && filename) mediaPayload.filename = filename;

  return retryableFetch<WhatsAppSendMessageResult>("sendMediaMessage", () =>
    fetch(`${WHATSAPP_API_BASE}/${phoneNumberId}/messages`, {
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
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    }),
  );
}

export async function sendWhatsAppInteractiveMessage(
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
): Promise<WhatsAppSendMessageResult> {
  const { phoneNumberId, accessToken } = await resolveCredentials();

  return retryableFetch<WhatsAppSendMessageResult>(
    "sendInteractiveMessage",
    () =>
      fetch(`${WHATSAPP_API_BASE}/${phoneNumberId}/messages`, {
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
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      }),
  );
}
