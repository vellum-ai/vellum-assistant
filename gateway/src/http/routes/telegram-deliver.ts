import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { getLogger } from "../../logger.js";
import { checkDeliverAuth } from "../middleware/deliver-auth.js";
import type { RuntimeAttachmentMeta } from "../../runtime/client.js";
import {
  sendTelegramAttachments,
  sendTelegramReply,
  sendTypingIndicator,
} from "../../telegram/send.js";

const log = getLogger("telegram-deliver");

export type ApprovalAction = {
  id: string;
  label: string;
};

export type ApprovalPayload = {
  requestId: string;
  actions: ApprovalAction[];
  plainTextFallback: string;
};

export function createTelegramDeliverHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache },
) {
  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const authResponse = checkDeliverAuth(
      req,
      config,
      "telegramDeliverAuthBypass",
    );
    if (authResponse) return authResponse;

    let body: {
      chatId?: string;
      text?: string;
      assistantId?: string;
      attachments?: RuntimeAttachmentMeta[];
      approval?: ApprovalPayload;
      chatAction?: "typing";
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const {
      chatId,
      text,
      assistantId: _assistantId,
      attachments,
      approval,
      chatAction,
    } = body;

    if (!chatId || typeof chatId !== "string") {
      return Response.json({ error: "chatId is required" }, { status: 400 });
    }

    if (chatAction !== undefined && chatAction !== "typing") {
      return Response.json(
        { error: 'chatAction must be "typing"' },
        { status: 400 },
      );
    }

    if (!text && (!attachments || attachments.length === 0) && !chatAction) {
      return Response.json(
        { error: "text, attachments, or chatAction required" },
        { status: 400 },
      );
    }

    // Validate attachment array shape and element types before accessing properties.
    // Without these checks, null or non-object elements would throw a TypeError
    // outside the delivery try/catch, producing an unhandled 500 instead of a 400.
    if (attachments) {
      if (!Array.isArray(attachments)) {
        return Response.json(
          { error: "attachments must be an array" },
          { status: 400 },
        );
      }
      for (const att of attachments) {
        if (att === null || typeof att !== "object" || Array.isArray(att)) {
          return Response.json(
            { error: "each attachment must be an object" },
            { status: 400 },
          );
        }
        if (!att.id || typeof att.id !== "string") {
          return Response.json(
            { error: "each attachment must have an id" },
            { status: 400 },
          );
        }
      }
    }

    // Validate approval payload shape when present.
    if (approval !== undefined) {
      if (
        approval === null ||
        typeof approval !== "object" ||
        Array.isArray(approval)
      ) {
        return Response.json(
          { error: "approval must be an object" },
          { status: 400 },
        );
      }
      if (!text) {
        return Response.json(
          { error: "text is required when approval is present" },
          { status: 400 },
        );
      }
      if (!approval.requestId || typeof approval.requestId !== "string") {
        return Response.json(
          { error: "approval.requestId is required" },
          { status: 400 },
        );
      }
      if (!Array.isArray(approval.actions) || approval.actions.length === 0) {
        return Response.json(
          { error: "approval.actions must be a non-empty array" },
          { status: 400 },
        );
      }
      for (const action of approval.actions) {
        if (
          action === null ||
          typeof action !== "object" ||
          Array.isArray(action)
        ) {
          return Response.json(
            { error: "each approval action must be an object" },
            { status: 400 },
          );
        }
        if (!action.id || typeof action.id !== "string") {
          return Response.json(
            { error: "each approval action must have an id" },
            { status: 400 },
          );
        }
        if (!action.label || typeof action.label !== "string") {
          return Response.json(
            { error: "each approval action must have a label" },
            { status: 400 },
          );
        }
        // Telegram enforces a 1-64 byte limit on callback_data. Validate
        // the would-be value up front so callers get a clear 400 instead of
        // a downstream Telegram API failure surfaced as a 502.
        const callbackData = `apr:${approval.requestId}:${action.id}`;
        if (Buffer.byteLength(callbackData) > 64) {
          return Response.json(
            {
              error: `callback_data for action "${action.id}" exceeds Telegram's 64-byte limit`,
            },
            { status: 400 },
          );
        }
      }
    }

    const credentialOpts = caches?.credentials
      ? { credentials: caches.credentials }
      : undefined;

    try {
      if (chatAction === "typing") {
        await sendTypingIndicator(config, chatId, credentialOpts);
      }

      if (text) {
        await sendTelegramReply(config, chatId, text, approval, credentialOpts);
      }

      if (attachments && attachments.length > 0) {
        await sendTelegramAttachments(
          config,
          chatId,
          attachments,
          credentialOpts,
        );
      }
    } catch (err) {
      tlog.error({ err, chatId }, "Failed to deliver Telegram reply");
      return Response.json({ error: "Delivery failed" }, { status: 502 });
    }

    tlog.info(
      {
        chatId,
        hasText: !!text,
        attachmentCount: attachments?.length ?? 0,
        chatAction,
      },
      "Reply sent",
    );
    return Response.json({ ok: true });
  };
}
