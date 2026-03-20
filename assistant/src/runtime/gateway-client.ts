import { createHash } from "node:crypto";

import { getLogger } from "../util/logger.js";
import type { ApprovalUIMetadata } from "./channel-approval-types.js";
import type { RuntimeAttachmentMetadata } from "./http-types.js";

const log = getLogger("gateway-client");

const DELIVERY_TIMEOUT_MS = 30_000;
const MANAGED_OUTBOUND_SEND_PATH =
  "/v1/internal/managed-gateway/outbound-send/";
const MANAGED_CALLBACK_TOKEN_HEADER = "X-Managed-Gateway-Callback-Token";
const MANAGED_IDEMPOTENCY_HEADER = "X-Idempotency-Key";
const MANAGED_OUTBOUND_MAX_ATTEMPTS = 3;
const MANAGED_OUTBOUND_RETRY_BASE_MS = 150;

export interface ChannelReplyPayload {
  chatId: string;
  text?: string;
  /** Pre-formatted Block Kit blocks for Slack delivery. */
  blocks?: unknown[];
  assistantId?: string;
  attachments?: RuntimeAttachmentMetadata[];
  approval?: ApprovalUIMetadata;
  chatAction?: "typing";
  /**
   * When true, deliver via `chat.postEphemeral` so only the target `user`
   * sees the message. Ephemeral messages are fire-and-forget: they cannot
   * be edited or deleted after posting.
   */
  ephemeral?: boolean;
  /** Slack user ID — required when `ephemeral` is true. */
  user?: string;
  /** When provided, instructs the delivery endpoint to update an existing message instead of posting a new one. */
  messageTs?: string;
  /** When true, auto-generate Block Kit blocks from text via textToBlocks(). */
  useBlocks?: boolean;
  /** When provided, add or remove an emoji reaction on a message. */
  reaction?: { action: "add" | "remove"; name: string; messageTs: string };
  /** When provided, set or clear the Slack Assistants API thread status. */
  assistantThreadStatus?: { channel: string; threadTs: string; status: string };
}

export interface ChannelDeliveryResult {
  ok: boolean;
  /** The message timestamp returned by the delivery endpoint (e.g. Slack message ts). */
  ts?: string;
}

interface ManagedOutboundCallbackContext {
  requestUrl: string;
  routeId: string;
  assistantId: string;
  sourceChannel: "phone";
  sourceUpdateId?: string;
  callbackToken?: string;
}

export async function deliverChannelReply(
  callbackUrl: string,
  payload: ChannelReplyPayload,
  bearerToken?: string,
): Promise<ChannelDeliveryResult> {
  const managedCallback = parseManagedOutboundCallback(callbackUrl);
  if (managedCallback) {
    await deliverManagedOutboundReply(managedCallback, payload, bearerToken);
    return { ok: true };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  }

  const response = await fetch(callbackUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    log.error(
      { status: response.status, body, callbackUrl, chatId: payload.chatId },
      "Channel reply delivery failed",
    );
    throw new Error(
      `Channel reply delivery failed (${response.status}): ${body}`,
    );
  }

  const result: ChannelDeliveryResult = { ok: true };
  try {
    const responseBody = (await response.json()) as Record<string, unknown>;
    if (typeof responseBody.ts === "string") {
      result.ts = responseBody.ts;
    }
  } catch {
    // Response may not be JSON for non-Slack channels; that's fine.
  }

  if (payload.chatAction) {
    log.debug(
      { chatId: payload.chatId, callbackUrl, chatAction: payload.chatAction },
      "Channel action delivered",
    );
  } else {
    log.info(
      { chatId: payload.chatId, callbackUrl },
      "Channel reply delivered",
    );
  }

  return result;
}

function parseManagedOutboundCallback(
  callbackUrl: string,
): ManagedOutboundCallbackContext | null {
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    return null;
  }

  const normalizedPath = parsed.pathname.endsWith("/")
    ? parsed.pathname
    : `${parsed.pathname}/`;
  if (normalizedPath !== MANAGED_OUTBOUND_SEND_PATH) {
    return null;
  }

  const routeId = parsed.searchParams.get("route_id")?.trim();
  const assistantId = parsed.searchParams.get("assistant_id")?.trim();
  const sourceChannel = parsed.searchParams.get("source_channel")?.trim();

  if (!routeId || !assistantId || sourceChannel !== "phone") {
    throw new Error(
      "Managed outbound callback URL is missing required route_id, assistant_id, or source_channel.",
    );
  }

  const sourceUpdateId = parsed.searchParams.get("source_update_id")?.trim();
  const callbackToken = parsed.searchParams.get("callback_token")?.trim();

  parsed.searchParams.delete("route_id");
  parsed.searchParams.delete("assistant_id");
  parsed.searchParams.delete("source_channel");
  parsed.searchParams.delete("source_update_id");
  parsed.searchParams.delete("callback_token");

  return {
    requestUrl: parsed.toString(),
    routeId,
    assistantId,
    sourceChannel,
    sourceUpdateId,
    callbackToken,
  };
}

async function deliverManagedOutboundReply(
  callback: ManagedOutboundCallbackContext,
  payload: ChannelReplyPayload,
  bearerToken?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (callback.callbackToken) {
    headers[MANAGED_CALLBACK_TOKEN_HEADER] = callback.callbackToken;
  } else if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  const hasAttachments =
    Array.isArray(payload.attachments) && payload.attachments.length > 0;
  const text = payload.approval?.plainTextFallback ?? payload.text;
  const normalizedText =
    typeof text === "string" && text.trim().length > 0 ? text : "";
  if (!normalizedText) {
    throw new Error(
      "Managed outbound delivery requires text or plainTextFallback.",
    );
  }

  const requestId = buildManagedOutboundRequestId(
    callback,
    payload,
    normalizedText,
  );
  headers[MANAGED_IDEMPOTENCY_HEADER] = requestId;

  const requestBody = JSON.stringify({
    route_id: callback.routeId,
    assistant_id: callback.assistantId,
    normalized_send: {
      version: "v1",
      sourceChannel: callback.sourceChannel,
      message: {
        to: payload.chatId,
        content: normalizedText,
        externalMessageId: requestId,
      },
      source: {
        requestId: requestId,
      },
      raw: {
        chatId: payload.chatId,
        text: payload.text ?? null,
        assistantId: payload.assistantId ?? null,
        chatAction: payload.chatAction ?? null,
        hasAttachments,
        sourceUpdateId: callback.sourceUpdateId ?? null,
      },
    },
  });

  for (let attempt = 1; attempt <= MANAGED_OUTBOUND_MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(callback.requestUrl, {
        method: "POST",
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt < MANAGED_OUTBOUND_MAX_ATTEMPTS) {
        const retryDelayMs = MANAGED_OUTBOUND_RETRY_BASE_MS * attempt;
        log.warn(
          {
            callbackUrl: callback.requestUrl,
            routeId: callback.routeId,
            requestId,
            chatId: payload.chatId,
            attempt,
            retryDelayMs,
            error,
          },
          "Managed outbound delivery attempt failed before response; retrying",
        );
        await sleep(retryDelayMs);
        continue;
      }
      throw error;
    }

    if (response.ok) {
      log.info(
        {
          routeId: callback.routeId,
          assistantId: callback.assistantId,
          sourceChannel: callback.sourceChannel,
          requestId,
          chatId: payload.chatId,
          attempt,
        },
        "Managed outbound delivery accepted",
      );
      return;
    }

    const responseBody = await response.text().catch(() => "<unreadable>");
    if (
      response.status >= 500 &&
      response.status < 600 &&
      attempt < MANAGED_OUTBOUND_MAX_ATTEMPTS
    ) {
      const retryDelayMs = MANAGED_OUTBOUND_RETRY_BASE_MS * attempt;
      log.warn(
        {
          callbackUrl: callback.requestUrl,
          routeId: callback.routeId,
          requestId,
          chatId: payload.chatId,
          attempt,
          status: response.status,
          responseBody,
          retryDelayMs,
        },
        "Managed outbound delivery got retriable upstream response; retrying",
      );
      await sleep(retryDelayMs);
      continue;
    }

    log.error(
      {
        status: response.status,
        body: responseBody,
        callbackUrl: callback.requestUrl,
        routeId: callback.routeId,
        requestId,
        chatId: payload.chatId,
        attempt,
      },
      "Managed outbound delivery failed",
    );
    throw new Error(
      `Managed outbound delivery failed (${response.status}): ${responseBody}`,
    );
  }
}

function buildManagedOutboundRequestId(
  callback: ManagedOutboundCallbackContext,
  payload: ChannelReplyPayload,
  normalizedText: string,
): string {
  const bodyMaterial = JSON.stringify({
    callback: {
      routeId: callback.routeId,
      assistantId: callback.assistantId,
      sourceChannel: callback.sourceChannel,
      sourceUpdateId: callback.sourceUpdateId ?? null,
    },
    payload: {
      chatId: payload.chatId,
      text: normalizedText,
      assistantId: payload.assistantId ?? null,
      chatAction: payload.chatAction ?? null,
      hasAttachments:
        Array.isArray(payload.attachments) && payload.attachments.length > 0,
      approvalRequestId: payload.approval?.requestId ?? null,
      approvalActions:
        payload.approval?.actions.map((action) => action.id) ?? null,
    },
  });

  const digest = createHash("sha256")
    .update(bodyMaterial)
    .digest("hex")
    .slice(0, 40);
  return `mgw-send-${digest}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Deliver an approval prompt (text + inline keyboard metadata) to the
 * gateway so it can render the approval UI in the channel.
 */
export async function deliverApprovalPrompt(
  callbackUrl: string,
  chatId: string,
  text: string,
  approval: ApprovalUIMetadata,
  assistantId?: string,
  bearerToken?: string,
): Promise<void> {
  await deliverChannelReply(
    callbackUrl,
    { chatId, text, approval, assistantId },
    bearerToken,
  );
}
