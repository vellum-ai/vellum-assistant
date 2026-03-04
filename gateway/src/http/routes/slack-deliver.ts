import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { checkDeliverAuth } from "../middleware/deliver-auth.js";
import { classifySlackError } from "../../slack/errors.js";

const log = getLogger("slack-deliver");
const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_AFTER_S = 1;

type SlackApiResult = {
  ok: boolean;
  error?: string;
  ts?: string;
};

/**
 * Call a Slack API method with rate-limit retries. Returns the parsed
 * JSON body on success, or a ready-made error Response on failure.
 */
async function callSlackApiWithRetries(
  url: string,
  slackBody: Record<string, string>,
  botToken: string,
  chatId: string,
  tlog: Pick<ReturnType<typeof getLogger>, "error" | "warn" | "info">,
): Promise<SlackApiResult | Response> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(slackBody),
    });

    // Handle HTTP-level 429 rate limits
    if (response.status === 429) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        tlog.error({ chatId }, "Slack rate limit exceeded after retries");
        return Response.json({ error: "Rate limited" }, { status: 429 });
      }
      const retryAfter =
        parseInt(response.headers.get("Retry-After") ?? "", 10) ||
        DEFAULT_RETRY_AFTER_S;
      tlog.warn(
        { chatId, retryAfter, attempt },
        "Slack rate limited, retrying",
      );
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
      ts?: string;
    };

    if (!data.ok) {
      lastError = data.error;
      const category = classifySlackError(data.error);

      // Retry rate-limited responses from the body
      if (category === "rate_limit" && attempt < MAX_RATE_LIMIT_RETRIES) {
        tlog.warn(
          { chatId, slackError: data.error, attempt },
          "Slack rate limited (body), retrying",
        );
        await new Promise((r) => setTimeout(r, DEFAULT_RETRY_AFTER_S * 1000));
        continue;
      }

      tlog.error(
        { chatId, slackError: data.error, category },
        "Slack API returned error",
      );

      if (category === "rate_limit") {
        return Response.json({ error: "Rate limited" }, { status: 429 });
      }
      if (category === "channel_not_found" || category === "not_found") {
        return Response.json({ error: "Channel not found" }, { status: 404 });
      }
      if (category === "permission") {
        return Response.json({ error: "Permission denied" }, { status: 403 });
      }
      // Auth errors use 502 so downstream retry logic treats them as
      // transient (token rotation, brief credential desync). Permanent
      // auth failures will exhaust retries and be dead-lettered normally.
      return Response.json({ error: "Delivery failed" }, { status: 502 });
    }

    return { ok: true, ts: data.ts };
  }

  tlog.error(
    { chatId, slackError: lastError },
    "Slack delivery failed after retries",
  );
  return Response.json({ error: "Delivery failed" }, { status: 502 });
}

export function createSlackDeliverHandler(
  config: GatewayConfig,
  onThreadReply?: (threadTs: string) => void,
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
      "slackDeliverAuthBypass",
    );
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
      ephemeral?: boolean;
      user?: string;
      /** When provided, use chat.update to edit an existing message instead of posting a new one. */
      messageTs?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (typeof body !== "object" || body === null) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (
      body.attachments &&
      Array.isArray(body.attachments) &&
      body.attachments.length > 0
    ) {
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

    const isEphemeral = body.ephemeral === true;
    if (isEphemeral && (!body.user || typeof body.user !== "string")) {
      return Response.json(
        { error: "user is required for ephemeral messages" },
        { status: 400 },
      );
    }

    // Support threading via query param
    const threadTs = new URL(req.url).searchParams.get("threadTs") ?? undefined;
    const { messageTs } = body;
    const isUpdate = typeof messageTs === "string" && messageTs.length > 0;

    try {
      const slackBody: Record<string, string> = {
        channel: chatId,
        text,
      };
      if (threadTs) {
        slackBody.thread_ts = threadTs;
      }

      // Ephemeral messages are only visible to the target user and cannot be
      // edited or deleted after posting — they are fire-and-forget.
      if (isEphemeral) {
        slackBody.user = body.user!;
      }

      let result: SlackApiResult | Response;

      if (isUpdate) {
        // chat.update only accepts channel, ts, and text — thread_ts is not
        // a valid parameter and would cause the call to fail silently.
        const updateBody: Record<string, string> = {
          channel: chatId,
          text,
          ts: messageTs,
        };
        result = await callSlackApiWithRetries(
          "https://slack.com/api/chat.update",
          updateBody,
          config.slackChannelBotToken,
          chatId,
          tlog,
        );

        // Fall back to posting a new message if update fails
        if (result instanceof Response) {
          tlog.warn(
            { chatId, messageTs },
            "Slack chat.update failed, falling back to chat.postMessage",
          );
          result = await callSlackApiWithRetries(
            "https://slack.com/api/chat.postMessage",
            slackBody,
            config.slackChannelBotToken,
            chatId,
            tlog,
          );
        }
      } else {
        const slackMethod = isEphemeral
          ? "chat.postEphemeral"
          : "chat.postMessage";

        result = await callSlackApiWithRetries(
          `https://slack.com/api/${slackMethod}`,
          slackBody,
          config.slackChannelBotToken,
          chatId,
          tlog,
        );
      }

      // If result is a Response, it's an error response — return it directly
      if (result instanceof Response) {
        return result;
      }

      const responseTs = result.ts;

      tlog.info(
        {
          chatId,
          hasThreadTs: !!threadTs,
          isUpdate,
          ephemeral: isEphemeral,
          responseTs,
        },
        isUpdate ? "Slack message updated" : "Slack message sent",
      );

      // Track the thread so future replies without @mention are forwarded.
      // Skip for ephemeral sends — they are user-specific and should not
      // activate global thread tracking for all participants.
      if (threadTs && onThreadReply && !isEphemeral) {
        onThreadReply(threadTs);
      }

      return Response.json({ ok: true, ts: responseTs });
    } catch (err) {
      tlog.error({ err, chatId }, "Failed to deliver Slack message");
      return Response.json({ error: "Delivery failed" }, { status: 502 });
    }
  };
}
