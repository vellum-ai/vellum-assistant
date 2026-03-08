import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { getLogger } from "../../logger.js";
import type { RuntimeAttachmentMeta } from "../../runtime/client.js";
import type { WhatsAppApiCaches } from "../../whatsapp/api.js";
import { checkDeliverAuth } from "../middleware/deliver-auth.js";
import {
  sendWhatsAppAttachments,
  sendWhatsAppReply,
} from "../../whatsapp/send.js";

const log = getLogger("whatsapp-deliver");

export type ApprovalAction = {
  id: string;
  label: string;
};

export type ApprovalPayload = {
  requestId: string;
  actions: ApprovalAction[];
  plainTextFallback: string;
};

export function createWhatsAppDeliverHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache },
) {
  const apiCaches: WhatsAppApiCaches | undefined = caches?.credentials
    ? { credentials: caches.credentials }
    : undefined;

  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const authResponse = checkDeliverAuth(
      req,
      config,
      "whatsappDeliverAuthBypass",
    );
    if (authResponse) return authResponse;

    // WhatsApp credential availability is gated by the route precondition
    // (isWhatsAppConfigured) — no config check needed here.

    let body: {
      chatId?: string;
      to?: string;
      text?: string;
      assistantId?: string;
      attachments?: RuntimeAttachmentMeta[];
      approval?: ApprovalPayload;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Accept `chatId` as an alias for `to` — runtime channel callbacks send `{ chatId, text }`.
    const to = body.to ?? body.chatId;

    if (!to || typeof to !== "string") {
      return Response.json({ error: "to is required" }, { status: 400 });
    }

    const { text, assistantId: _assistantId, attachments, approval } = body;

    if (text !== undefined && typeof text !== "string") {
      return Response.json({ error: "text must be a string" }, { status: 400 });
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
      }
    }

    if (!text && (!attachments || attachments.length === 0)) {
      return Response.json(
        { error: "text or attachments required" },
        { status: 400 },
      );
    }

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

    let textSent = false;

    try {
      if (text) {
        await sendWhatsAppReply(config, to, text, approval, apiCaches);
        textSent = true;
      }
    } catch (err) {
      tlog.error({ err, to }, "Failed to deliver WhatsApp text");
      return Response.json({ error: "Delivery failed" }, { status: 502 });
    }

    if (attachments && attachments.length > 0) {
      const result = await sendWhatsAppAttachments(
        config,
        to,
        attachments,
        apiCaches,
      );

      if (result.allFailed && !textSent) {
        // Nothing was delivered at all -- signal failure so the caller can retry
        tlog.error(
          { to, failureCount: result.failureCount },
          "All attachments failed and no text was sent",
        );
        return Response.json({ error: "Delivery failed" }, { status: 502 });
      }

      if (result.failureCount > 0) {
        tlog.warn(
          {
            to,
            failureCount: result.failureCount,
            totalCount: result.totalCount,
          },
          "Partial attachment delivery failure",
        );
      }
    }

    tlog.info(
      {
        to,
        hasText: !!text,
        attachmentCount: attachments?.length ?? 0,
        hasApproval: !!approval,
      },
      "WhatsApp reply sent",
    );
    return Response.json({ ok: true });
  };
}
