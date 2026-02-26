import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { checkDeliverAuth } from "../middleware/deliver-auth.js";

const log = getLogger("slack-deliver");

export function createSlackDeliverHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const authResponse = checkDeliverAuth(req, config, "slackDeliverAuthBypass");
    if (authResponse) return authResponse;

    if (!config.slackChannelBotToken) {
      tlog.error("Slack bot token not configured");
      return Response.json(
        { error: "Slack integration not configured" },
        { status: 503 },
      );
    }

    let body: {
      chatId?: string;
      to?: string;
      text?: string;
      assistantId?: string;
      attachments?: unknown[];
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (typeof body !== 'object' || body === null) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (body.attachments && Array.isArray(body.attachments) && body.attachments.length > 0) {
      return Response.json(
        { error: "Slack attachments not supported in MVP" },
        { status: 400 },
      );
    }

    // Accept `chatId` as an alias for `to` so runtime channel callbacks work without translation.
    const chatId = body.chatId ?? body.to;

    if (!chatId || typeof chatId !== "string") {
      return Response.json({ error: "chatId is required" }, { status: 400 });
    }

    const { text } = body;

    if (!text || typeof text !== "string") {
      return Response.json({ error: "text is required" }, { status: 400 });
    }

    // Support threading via query param
    const threadTs = new URL(req.url).searchParams.get("threadTs") ?? undefined;

    try {
      const slackBody: Record<string, string> = {
        channel: chatId,
        text,
      };
      if (threadTs) {
        slackBody.thread_ts = threadTs;
      }

      const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.slackChannelBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(slackBody),
      });

      const data = (await response.json()) as { ok?: boolean; error?: string };

      if (!data.ok) {
        tlog.error({ chatId, slackError: data.error }, "Slack API returned error");
        return Response.json({ error: "Delivery failed" }, { status: 502 });
      }
    } catch (err) {
      tlog.error({ err, chatId }, "Failed to deliver Slack message");
      return Response.json({ error: "Delivery failed" }, { status: 502 });
    }

    tlog.info({ chatId, hasThreadTs: !!threadTs }, "Slack message sent");
    return Response.json({ ok: true });
  };
}
