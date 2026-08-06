import type { CredentialCache } from "../credential-cache.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";
import type { RetryableFetchHooks } from "../util/retryable-fetch.js";
import { retryableFetch } from "../util/retryable-fetch.js";

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

// Auth/permission errors are transient: a token rotation or permission fix
// can resolve them within Meta's retry window. These should NOT be treated as
// non-retryable so the webhook returns 500 and Meta retries the delivery.
function isAuthError(status: number): boolean {
  return status === 401 || status === 403;
}

function buildWhatsAppFailureMessage(
  operation: string,
  status: number,
  errorMessage: string | undefined,
  body: string,
): string {
  return errorMessage
    ? `WhatsApp ${operation} failed: ${errorMessage}`
    : body
      ? `WhatsApp ${operation} failed with status ${status}: ${body}`
      : `WhatsApp ${operation} failed with status ${status}`;
}

async function readWhatsAppErrorBody(response: Response): Promise<{
  body: string;
  errorMessage: string | undefined;
}> {
  const body = await response.text().catch(() => "");
  let errorMessage: string | undefined;
  try {
    const data = JSON.parse(body) as WhatsAppApiErrorResponse;
    errorMessage = data.error?.message;
  } catch {
    // Response body is not JSON; the raw text is still returned for messages
  }
  return { body, errorMessage };
}

function whatsAppErrorHooks(
  operation: string,
): Pick<RetryableFetchHooks<never>, "throwTerminal" | "describeRetryable"> {
  return {
    throwTerminal: async (response) => {
      const { body, errorMessage } = await readWhatsAppErrorBody(response);
      const message = buildWhatsAppFailureMessage(
        operation,
        response.status,
        errorMessage,
        body,
      );

      // Auth/permission errors (401/403) are transient: propagate as regular
      // errors so the webhook returns 500 and Meta retries within its window.
      // Other 4xx errors (400 invalid media, 404 expired) are terminal.
      if (isAuthError(response.status)) {
        throw new Error(message);
      }
      throw new WhatsAppNonRetryableError(message);
    },
    describeRetryable: async (response) => {
      const retryAfter = response.headers.get("retry-after");
      const { body, errorMessage } = await readWhatsAppErrorBody(response);
      return {
        retryAfter,
        error: new Error(
          buildWhatsAppFailureMessage(
            operation,
            response.status,
            errorMessage,
            body,
          ),
        ),
      };
    },
  };
}

async function retryableWhatsAppFetch<T>(
  configFile: ConfigFileCache | undefined,
  operation: string,
  doFetch: () => Promise<Response>,
): Promise<T> {
  return retryableFetch<T>(
    {
      provider: "WhatsApp",
      operation,
      log,
      configFile,
      configSection: "whatsapp",
      doFetch,
    },
    {
      ...whatsAppErrorHooks(operation),
      parseSuccess: async (response) => (await response.json()) as T,
    },
  );
}

/** Options bag for optional credential and config cache injection into WhatsApp API calls. */
export type WhatsAppApiCaches = {
  credentials?: CredentialCache;
  configFile?: ConfigFileCache;
};

/**
 * Resolve WhatsApp credentials from cache.
 * Returns undefined fields if the cache has no values.
 */
async function resolveWhatsAppCredentials(caches?: WhatsAppApiCaches): Promise<{
  phoneNumberId: string | undefined;
  accessToken: string | undefined;
}> {
  let phoneNumberId: string | undefined;
  let accessToken: string | undefined;
  if (caches?.credentials) {
    phoneNumberId = await caches.credentials.get(
      credentialKey("whatsapp", "phone_number_id"),
    );
    accessToken = await caches.credentials.get(
      credentialKey("whatsapp", "access_token"),
    );
  }
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
  to: string,
  text: string,
  caches?: WhatsAppApiCaches,
): Promise<WhatsAppSendMessageResult> {
  const { phoneNumberId, accessToken } =
    await resolveWhatsAppCredentials(caches);
  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }

  const timeoutMs =
    caches?.configFile?.getNumber("whatsapp", "timeoutMs") ?? 15000;

  return retryableWhatsAppFetch<WhatsAppSendMessageResult>(
    caches?.configFile,
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
        signal: AbortSignal.timeout(timeoutMs),
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
  blob: Blob,
  filename: string,
  mimeType: string,
  caches?: WhatsAppApiCaches,
): Promise<WhatsAppMediaUploadResult> {
  const { phoneNumberId, accessToken } =
    await resolveWhatsAppCredentials(caches);
  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }

  const timeoutMs =
    caches?.configFile?.getNumber("whatsapp", "timeoutMs") ?? 15000;

  return retryableWhatsAppFetch<WhatsAppMediaUploadResult>(
    caches?.configFile,
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
        signal: AbortSignal.timeout(timeoutMs),
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
  to: string,
  mediaType: WhatsAppMediaType,
  mediaId: string,
  filename?: string,
  caption?: string,
  caches?: WhatsAppApiCaches,
): Promise<WhatsAppSendMessageResult> {
  const { phoneNumberId, accessToken } =
    await resolveWhatsAppCredentials(caches);
  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }

  const mediaPayload: Record<string, unknown> = { id: mediaId };
  if (caption) mediaPayload.caption = caption;
  // WhatsApp only supports filename on document type
  if (mediaType === "document" && filename) mediaPayload.filename = filename;

  const timeoutMs =
    caches?.configFile?.getNumber("whatsapp", "timeoutMs") ?? 15000;

  return retryableWhatsAppFetch<WhatsAppSendMessageResult>(
    caches?.configFile,
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
        signal: AbortSignal.timeout(timeoutMs),
      }),
  );
}

/**
 * Send an interactive button message via the WhatsApp Business Cloud API.
 * Used for approval prompts where the user can tap a button to respond.
 * WhatsApp supports up to 3 reply buttons per interactive message.
 */
export async function sendWhatsAppInteractiveMessage(
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
  caches?: WhatsAppApiCaches,
): Promise<WhatsAppSendMessageResult> {
  const { phoneNumberId, accessToken } =
    await resolveWhatsAppCredentials(caches);
  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }

  const timeoutMs =
    caches?.configFile?.getNumber("whatsapp", "timeoutMs") ?? 15000;

  return retryableWhatsAppFetch<WhatsAppSendMessageResult>(
    caches?.configFile,
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
        signal: AbortSignal.timeout(timeoutMs),
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
  mediaId: string,
  caches?: WhatsAppApiCaches,
): Promise<WhatsAppMediaMetadata> {
  const { accessToken } = await resolveWhatsAppCredentials(caches);
  if (!accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }

  const timeoutMs =
    caches?.configFile?.getNumber("whatsapp", "timeoutMs") ?? 15000;

  return retryableWhatsAppFetch<WhatsAppMediaMetadata>(
    caches?.configFile,
    "getMediaMetadata",
    () =>
      fetchImpl(`${WHATSAPP_API_BASE}/${mediaId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      }),
  );
}

/**
 * Download the raw bytes of a WhatsApp media object given its CDN URL.
 * The URL comes from getWhatsAppMediaMetadata and requires the access token.
 * Returns the raw Response so callers can stream or buffer as needed.
 */
export async function downloadWhatsAppMediaBytes(
  mediaUrl: string,
  caches?: WhatsAppApiCaches,
): Promise<Response> {
  const { accessToken } = await resolveWhatsAppCredentials(caches);
  if (!accessToken) {
    throw new Error("WhatsApp credentials not configured");
  }

  const timeoutMs =
    caches?.configFile?.getNumber("whatsapp", "timeoutMs") ?? 15000;

  return retryableWhatsAppRawFetch(caches?.configFile, "downloadMedia", () =>
    fetchImpl(mediaUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
}

/**
 * Like retryableWhatsAppFetch but returns the raw Response instead of parsing JSON.
 * Used for binary downloads where the response body is not JSON.
 */
async function retryableWhatsAppRawFetch(
  configFile: ConfigFileCache | undefined,
  operation: string,
  doFetch: () => Promise<Response>,
): Promise<Response> {
  return retryableFetch<Response>(
    {
      provider: "WhatsApp",
      operation,
      log,
      configFile,
      configSection: "whatsapp",
      doFetch,
    },
    {
      ...whatsAppErrorHooks(operation),
      parseSuccess: async (response) => response,
    },
  );
}

/**
 * Mark an incoming WhatsApp message as read.
 * Best-effort — callers should not propagate errors from this.
 */
export async function markWhatsAppMessageRead(
  messageId: string,
  caches?: WhatsAppApiCaches,
): Promise<void> {
  const { phoneNumberId, accessToken } =
    await resolveWhatsAppCredentials(caches);
  if (!phoneNumberId || !accessToken) return;

  const timeoutMs =
    caches?.configFile?.getNumber("whatsapp", "timeoutMs") ?? 15000;

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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    log.debug({ err, messageId }, "Failed to mark WhatsApp message as read");
  }
}
