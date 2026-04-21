/**
 * Generates a pre-filled Slack app manifest creation URL.
 *
 * Usage: bun skills/slack-app-setup/generate-manifest-url.ts <bot-name> [bot-description]
 *
 * The manifest is the single source of truth for all required scopes,
 * event subscriptions, and settings. Keep it in sync with
 * assistant/src/daemon/handlers/slack-channel-oauth-install.ts.
 */

const name = process.argv[2];
const desc = process.argv[3] ?? "";

if (!name) {
  console.error(
    "Usage: bun generate-manifest-url.ts <bot-name> [bot-description]",
  );
  process.exit(1);
}

const manifest = {
  display_information: {
    name,
    description: desc,
    background_color: "#1a1a2e",
  },
  features: {
    app_home: {
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    },
    bot_user: {
      display_name: name,
      always_online: true,
    },
  },
  oauth_config: {
    redirect_urls: ["http://localhost:17322/oauth/callback"],
    scopes: {
      bot: [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:join",
        "channels:read",
        "chat:write",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "reactions:read",
        "reactions:write",
        "users:read",
      ],
      user: [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "search:read",
        "reactions:read",
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
      ],
    },
    interactivity: {
      is_enabled: true,
    },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

const url =
  "https://api.slack.com/apps?new_app=1&manifest_json=" +
  encodeURIComponent(JSON.stringify(manifest));

console.log(url);
