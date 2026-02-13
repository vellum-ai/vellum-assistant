import pino from "pino";
import type { GatewayConfig } from "../config.js";

const log = pino({ name: "gateway:runtime-client" });

const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 500;

export type RuntimeInboundPayload = {
  sourceChannel: string;
  externalChatId: string;
  externalMessageId: string;
  content: string;
  senderName?: string;
  senderExternalUserId?: string;
  senderUsername?: string;
  sourceMetadata?: Record<string, unknown>;
  attachmentIds?: string[];
};

export type RuntimeInboundResponse = {
  accepted: boolean;
  duplicate: boolean;
  eventId: string;
  assistantMessage?: {
    id: string;
    role: "assistant";
    content: string;
    timestamp: string;
    attachments: unknown[];
  };
};

export async function forwardToRuntime(
  config: GatewayConfig,
  assistantId: string,
  payload: RuntimeInboundPayload,
): Promise<RuntimeInboundResponse> {
  const url = `${config.assistantRuntimeBaseUrl}/v1/assistants/${encodeURIComponent(assistantId)}/channels/inbound`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
      log.debug({ attempt, delay, assistantId }, "Retrying runtime forward");
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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

export type UploadAttachmentInput = {
  filename: string;
  mimeType: string;
  data: string; // base64-encoded
};

export type UploadAttachmentResponse = {
  id: string;
};

export async function uploadAttachment(
  config: GatewayConfig,
  assistantId: string,
  input: UploadAttachmentInput,
): Promise<UploadAttachmentResponse> {
  const url = `${config.assistantRuntimeBaseUrl}/v1/assistants/${encodeURIComponent(assistantId)}/attachments`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Attachment upload failed (${response.status}): ${body}`);
  }

  return (await response.json()) as UploadAttachmentResponse;
}
