/**
 * Bot scopes the app cannot function without. A workspace that declines any of
 * these gets a failed install rather than a silently degraded one.
 */
const SLACK_BOT_SCOPES_REQUIRED = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "users:read",
] as const;

/**
 * Bot scopes the app degrades gracefully without. Slack lists these separately
 * on the install consent screen, so a workspace that declines them makes a
 * visible choice instead of tripping the silent-drop trap (see LUM-2830).
 * Optional does not mean unwanted — the scope-drift probe still checks them.
 */
const SLACK_BOT_SCOPES_OPTIONAL = [
  "channels:join",
  "files:read",
  "files:write",
  "reactions:read",
  "reactions:write",
] as const;

const SLACK_USER_SCOPES_REQUIRED = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
] as const;

const SLACK_USER_SCOPES_OPTIONAL = ["search:read", "reactions:read"] as const;

/**
 * Every bot scope the manifest asks for, required and optional alike.
 *
 * The scope-drift probe diffs against this full list on purpose: marking a
 * scope optional changes how Slack asks for it, not whether we want it. A
 * dropped optional scope should still surface the reinstall nudge.
 */
export const SLACK_MANIFEST_BOT_SCOPES = [
  ...SLACK_BOT_SCOPES_REQUIRED,
  ...SLACK_BOT_SCOPES_OPTIONAL,
] as const;

/** Slack caps `display_information.name` at 35 characters. */
const MAX_NAME_LENGTH = 35;

/** Slack caps `display_information.description` at 140 characters. */
const MAX_DESCRIPTION_LENGTH = 140;

/** Slack caps `features.agent_view.agent_description` at 300 characters. */
const MAX_AGENT_DESCRIPTION_LENGTH = 300;

/**
 * Build the Slack app manifest for a bot with the given display name and
 * optional description, as a plain object ready to be JSON-stringified and
 * pasted into the "From a manifest" tile of Slack's create-app modal.
 *
 * Canonical source: skills/slack-app-setup/scripts/build-manifest-url.ts
 * Duplicated here because skills cannot import from client packages.
 * Keep both in sync when changing scopes, events, or manifest shape.
 */
export function buildSlackManifest(name: string, desc = "") {
  const safeName = name.trim().slice(0, MAX_NAME_LENGTH) || "My Assistant";

  return {
    display_information: {
      name: safeName,
      ...(desc ? { description: desc.slice(0, MAX_DESCRIPTION_LENGTH) } : {}),
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
      // `agent_view` supersedes `assistant_view` (Slack Agent messaging,
      // Jun 30 2026). The description field is renamed — `agent_view` declares
      // `additionalProperties: false`, so the old `assistant_description` key
      // would be rejected outright. Migration is one-way per Slack's docs.
      agent_view: {
        agent_description: (desc || safeName).slice(
          0,
          MAX_AGENT_DESCRIPTION_LENGTH,
        ),
        suggested_prompts: [],
      },
    },
    oauth_config: {
      scopes: {
        bot: [...SLACK_BOT_SCOPES_REQUIRED],
        bot_optional: [...SLACK_BOT_SCOPES_OPTIONAL],
        user: [...SLACK_USER_SCOPES_REQUIRED],
        user_optional: [...SLACK_USER_SCOPES_OPTIONAL],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [
          "app_mention",
          // Requires `agent_view`; carries the user's active Slack context.
          "app_context_changed",
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
}

/**
 * Legacy deep link that pre-fills Slack's create-app form from a manifest.
 *
 * Slack's new create-app modal (rolled out ~Jul 2026) ignores the
 * `manifest_json` query parameter, so the wizard now uses the copy-paste flow
 * built on {@link buildSlackManifest} instead. Kept as a fallback for older
 * Slack surfaces and for the setup skill.
 */
export function buildSlackManifestUrl(name: string, desc = ""): string {
  return (
    "https://api.slack.com/apps?new_app=1&manifest_json=" +
    encodeURIComponent(JSON.stringify(buildSlackManifest(name, desc)))
  );
}
