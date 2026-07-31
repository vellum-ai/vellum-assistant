/**
 * Every bot scope the manifest requests.
 *
 * {@link SLACK_MANIFEST_BOT_SCOPES_OPTIONAL} marks the subset a workspace may
 * decline; everything here is requested either way.
 */
export const SLACK_MANIFEST_BOT_SCOPES = [
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
] as const;

/**
 * Bot scopes a workspace may decline at install without breaking the app.
 * Slack lists them separately on the consent screen, so declining one is a
 * visible choice rather than a silent drop (see LUM-2830).
 *
 * Must be a subset of {@link SLACK_MANIFEST_BOT_SCOPES}: Slack reads `bot` as
 * the complete request and `bot_optional` as the opt-out subset within it, so
 * a scope listed only here is never requested at all.
 */
const SLACK_MANIFEST_BOT_SCOPES_OPTIONAL = [
  "channels:join",
  "files:read",
  "files:write",
  "reactions:read",
  "reactions:write",
] as const;

const SLACK_MANIFEST_USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "search:read",
  "users:read",
] as const;

/** Subset of {@link SLACK_MANIFEST_USER_SCOPES}, same contract as the bot side. */
const SLACK_USER_SCOPES_OPTIONAL = ["reactions:read", "search:read"] as const;

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
 * Canonical source: skills/slack-app-setup/scripts/build-manifest.ts
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
      // `agent_view` drives the Agent messaging experience. It declares
      // `additionalProperties: false` and names its description
      // `agent_description`, so an `assistant_description` key is rejected.
      // Slack treats the switch away from `assistant_view` as one-way.
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
        bot: [...SLACK_MANIFEST_BOT_SCOPES],
        bot_optional: [...SLACK_MANIFEST_BOT_SCOPES_OPTIONAL],
        user: [...SLACK_MANIFEST_USER_SCOPES],
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
