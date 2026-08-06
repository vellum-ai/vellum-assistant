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
import { retryableCall } from "../retry-policy.js";

const log = getLogger("whatsapp-api");

// Meta Cloud API v20 endpoint template
const WHATSAPP_API_BASE = "https://graph.facebook.com/v20.0";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class WhatsAppNonRetryableError extends Error {
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

function isAuthError(status: number): boolean {
  return status === 401 || status === 403;
}

function whatsappCall<T>(
  operation: string,
  doFetch: () => Promise<Response>,
): Promise<T> {
  return retryableCall<T>({
    provider: "WhatsApp",
    operation,
    maxRetries: DEFAULT_MAX_RETRIES,
    initialBackoffMs: DEFAULT_INITIAL_BACKOFF_MS,
    log,
    doFetch,
    detailFrom: (body) => {
      try {
        return (JSON.parse(body) as WhatsAppApiErrorResponse).error?.message;
      } catch {
        return undefined;
      }
    },
    // An auth failure is the operator's to fix, not a delivery fault, so it
    // surfaces as a plain Error rather than the channel's retryable type.
    nonRetryableError: ({ status, message }) =>
      isAuthError(status)
        ? new Error(message)
        : new WhatsAppNonRetryableError(message),
    decode: (body) => JSON.parse(body) as T,
  });
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

  return whatsappCall<WhatsAppSendMessageResult>("sendMessage", () =>
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

  return whatsappCall<WhatsAppMediaUploadResult>("uploadMedia", () => {
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
  if (caption) {
    mediaPayload.caption = caption;
  }
  if (mediaType === "document" && filename) {
    mediaPayload.filename = filename;
  }

  return whatsappCall<WhatsAppSendMessageResult>("sendMediaMessage", () =>
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

  return whatsappCall<WhatsAppSendMessageResult>("sendInteractiveMessage", () =>
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
