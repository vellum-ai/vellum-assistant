import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { checkDeliverAuth } from "../middleware/deliver-auth.js";

const log = getLogger("slack-deliver");

export type SlackApprovalAction = {
  id: string;
  label: string;
};

export type SlackApprovalPayload = {
  requestId: string;
  actions: SlackApprovalAction[];
  plainTextFallback: string;
};

/**
 * Build Block Kit blocks for an approval prompt.
 *
 * Produces a section block with the prompt text followed by an actions
 * block containing buttons for each approval action. Button values
 * encode `apr:{requestId}:{actionId}` matching the convention used by
 * Telegram and the interactive actions handler.
 */
export function buildApprovalBlocks(
  text: string,
  approval: SlackApprovalPayload,
): Array<Record<string, unknown>> {
  const buttons = approval.actions.map((action) => {
    const value = `apr:${approval.requestId}:${action.id}`;
    const button: Record<string, unknown> = {
      type: "button",
      text: {
        type: "plain_text",
        text: action.label,
        emoji: true,
      },
      action_id: `approval_${action.id}`,
      value,
    };
    if (action.id === "approve_once") {
      button.style = "primary";
    } else if (action.id === "reject") {
      button.style = "danger";
    }
    return button;
  });

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text,
      },
    },
    {
      type: "actions",
      block_id: `approval_${approval.requestId}`,
      elements: buttons,
    },
  ];
}

/**
 * Build Block Kit blocks that show the decision result after an
 * approval has been consumed. Replaces the action buttons with a
 * context line indicating the outcome.
 */
export function buildDecisionResultBlocks(
  originalText: string,
  decisionLabel: string,
): Array<Record<string, unknown>> {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: originalText,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: decisionLabel,
        },
      ],
    },
  ];
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
      approval?: SlackApprovalPayload;
      /** When set, update an existing message instead of posting a new one. */
      updateTs?: string;
      /** Decision label used when editing the message after approval consumption. */
      decisionLabel?: string;
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

    const { text, approval, updateTs, decisionLabel } = body;

    if (!text || typeof text !== "string") {
      return Response.json({ error: "text is required" }, { status: 400 });
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

    // Support threading via query param
    const threadTs = new URL(req.url).searchParams.get("threadTs") ?? undefined;

    try {
      // ── Message update path (post-decision edit) ──
      if (updateTs && typeof updateTs === "string") {
        const blocks =
          decisionLabel && typeof decisionLabel === "string"
            ? buildDecisionResultBlocks(text, decisionLabel)
            : [{ type: "section", text: { type: "mrkdwn", text } }];

        const updateBody: Record<string, unknown> = {
          channel: chatId,
          ts: updateTs,
          text,
          blocks,
        };

        const response = await fetchImpl("https://slack.com/api/chat.update", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.slackChannelBotToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updateBody),
        });

        const data = (await response.json()) as {
          ok?: boolean;
          error?: string;
        };
        if (!data.ok) {
          tlog.error(
            { chatId, updateTs, slackError: data.error },
            "Slack chat.update API returned error",
          );
          return Response.json({ error: "Update failed" }, { status: 502 });
        }

        tlog.info({ chatId, updateTs }, "Slack message updated");
        return Response.json({ ok: true });
      }

      // ── New message path ──
      const slackBody: Record<string, unknown> = {
        channel: chatId,
        text,
      };
      if (threadTs) {
        slackBody.thread_ts = threadTs;
      }

      // When an approval payload is present, render Block Kit blocks.
      if (approval) {
        slackBody.blocks = buildApprovalBlocks(text, approval);
      }

      const response = await fetchImpl(
        "https://slack.com/api/chat.postMessage",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.slackChannelBotToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(slackBody),
        },
      );

      const data = (await response.json()) as {
        ok?: boolean;
        error?: string;
        ts?: string;
      };

      if (!data.ok) {
        tlog.error(
          { chatId, slackError: data.error },
          "Slack API returned error",
        );
        return Response.json({ error: "Delivery failed" }, { status: 502 });
      }

      tlog.info(
        { chatId, hasThreadTs: !!threadTs, hasApproval: !!approval },
        "Slack message sent",
      );

      // Track the thread so future replies without @mention are forwarded
      if (threadTs && onThreadReply) {
        onThreadReply(threadTs);
      }

      // Return the message timestamp so callers can reference it for updates.
      return Response.json({ ok: true, ts: data.ts });
    } catch (err) {
      tlog.error({ err, chatId }, "Failed to deliver Slack message");
      return Response.json({ error: "Delivery failed" }, { status: 502 });
    }
  };
}
