import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { checkDeliverAuth } from "../middleware/deliver-auth.js";
import type { RuntimeAttachmentMeta } from "../../runtime/client.js";

const log = getLogger("a2a-deliver");

export function createA2ADeliverHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
) {
  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const isBypassed =
      process.env.APP_VERSION === "0.0.0-dev" &&
      (caches?.configFile?.getBoolean("a2a", "deliverAuthBypass") ?? false);
    const authResponse = checkDeliverAuth(req, isBypassed);
    if (authResponse) return authResponse;

    // Read target routing from query params (set at inbound time)
    const url = new URL(req.url);
    const gatewayUrl = url.searchParams.get("gatewayUrl");
    const assistantId = url.searchParams.get("assistantId");

    if (!gatewayUrl || !assistantId) {
      return Response.json(
        { error: "gatewayUrl and assistantId query params are required" },
        { status: 400 },
      );
    }

    // Accept standard ChannelReplyPayload — same shape as Telegram/Slack/WhatsApp
    let body: {
      chatId?: string;
      text?: string;
      assistantId?: string;
      attachments?: RuntimeAttachmentMeta[];
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { text } = body;

    if (!text || typeof text !== "string") {
      return Response.json({ error: "text is required" }, { status: 400 });
    }

    // Check for unauthenticated send permission (for pairing responses)
    const allowUnauthenticated =
      url.searchParams.get("allowUnauthenticated") === "true";

    // Resolve outbound Bearer token from credential store
    const outboundToken = caches?.credentials
      ? await caches.credentials.get(`a2a:outbound:${assistantId}`)
      : undefined;

    if (!outboundToken && !allowUnauthenticated) {
      tlog.warn(
        { assistantId },
        "No outbound token found for target assistant",
      );
      return Response.json(
        {
          error: "Outbound token not found",
          userMessage:
            "Cannot send message — no authentication token for target assistant. Pairing may not be complete.",
        },
        { status: 502 },
      );
    }

    // Build A2A message envelope
    const envelope = {
      version: "v1" as const,
      type: "message" as const,
      senderAssistantId: config.defaultAssistantId ?? "unknown",
      messageId: crypto.randomUUID(),
      content: text,
    };

    // POST to target gateway
    const targetUrl = `${gatewayUrl}/webhook/a2a`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (outboundToken) {
      headers["Authorization"] = `Bearer ${outboundToken}`;
    }

    try {
      const response = await fetchImpl(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(config.runtimeTimeoutMs),
      });

      if (!response.ok) {
        const responseBody = await response.text();
        tlog.error(
          {
            assistantId,
            gatewayUrl,
            status: response.status,
            body: responseBody,
          },
          "A2A deliver failed — target gateway returned error",
        );
        return Response.json(
          {
            error: "Delivery failed",
            userMessage: `Target assistant returned ${response.status}`,
          },
          { status: 502 },
        );
      }

      tlog.info({ assistantId, gatewayUrl }, "A2A message delivered");

      return Response.json({ ok: true });
    } catch (err) {
      tlog.error(
        { err, assistantId, gatewayUrl },
        "A2A deliver failed — target gateway unreachable",
      );
      return Response.json(
        {
          error: "Delivery failed",
          userMessage:
            "Target assistant is unreachable. Check network connectivity.",
        },
        { status: 502 },
      );
    }
  };
}
