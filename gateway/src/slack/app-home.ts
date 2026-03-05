import { getLogger } from "../logger.js";
import { fetchImpl } from "../fetch.js";

const log = getLogger("slack-app-home");

/**
 * Block Kit block types used in App Home views.
 */
export type SlackBlock =
  | {
      type: "header";
      text: { type: "plain_text"; text: string; emoji?: boolean };
    }
  | {
      type: "section";
      text: { type: "mrkdwn"; text: string };
      accessory?: SlackAccessory;
    }
  | { type: "divider" }
  | { type: "actions"; elements: SlackAccessory[] };

type SlackAccessory = {
  type: "button";
  text: { type: "plain_text"; text: string; emoji?: boolean };
  action_id: string;
  url?: string;
};

export type AppHomeView = {
  type: "home";
  blocks: SlackBlock[];
};

export type AppHomeContext = {
  botUsername?: string;
  workspaceName?: string;
  connected: boolean;
};

/**
 * Build the App Home view payload with connection status and capabilities info.
 */
export function buildAppHomeView(ctx: AppHomeContext): AppHomeView {
  const statusEmoji = ctx.connected ? ":large_green_circle:" : ":red_circle:";
  const statusText = ctx.connected ? "Connected" : "Disconnected";

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Vellum Assistant",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${statusEmoji} *Status:* ${statusText}`,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "*Connection Info*",
          ctx.workspaceName ? `• Workspace: ${ctx.workspaceName}` : null,
          ctx.botUsername ? `• Bot: @${ctx.botUsername}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "*Capabilities*",
          "• Mention me in any channel to start a conversation",
          "• Send me a direct message for private interactions",
          "• I can reply in threads to keep conversations organized",
        ].join("\n"),
      },
    },
  ];

  return { type: "home", blocks };
}

/**
 * Publish the App Home view for a specific user via `views.publish`.
 */
export async function publishAppHome(
  botToken: string,
  userId: string,
  ctx: AppHomeContext,
): Promise<void> {
  const view = buildAppHomeView(ctx);

  const resp = await fetchImpl("https://slack.com/api/views.publish", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ user_id: userId, view }),
  });

  const data = (await resp.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    log.error({ userId, error: data.error }, "Failed to publish App Home view");
  } else {
    log.debug({ userId }, "Published App Home view");
  }
}
