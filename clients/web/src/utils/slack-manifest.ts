const SLACK_MANIFEST_SCOPES = {
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
} as const;

/**
 * Build the Slack "create app from manifest" URL for a bot with the given
 * display name and optional description. The returned URL encodes a full
 * manifest with all required scopes, events, and Socket Mode enabled.
 *
 * Canonical source: skills/slack-app-setup/scripts/build-manifest-url.ts
 * Duplicated here because skills cannot import from client packages.
 * Keep both in sync when changing scopes, events, or manifest shape.
 */
export function buildSlackManifestUrl(name: string, desc = ""): string {
  const safeName = name.trim().slice(0, 35) || "My Assistant";
  const manifest = {
    display_information: {
      name: safeName,
      ...(desc ? { description: desc } : {}),
      background_color: "#1a1a2e",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: safeName,
        always_online: true,
      },
      assistant_view: {
        assistant_description: desc || safeName,
        suggested_prompts: [],
      },
    },
    oauth_config: { scopes: SLACK_MANIFEST_SCOPES },
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
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };

  return (
    "https://api.slack.com/apps?new_app=1&manifest_json=" +
    encodeURIComponent(JSON.stringify(manifest))
  );
}
