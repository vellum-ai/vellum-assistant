#!/usr/bin/env bun
// Builds a Slack app manifest creation URL.
//
// Usage (preferred — robust to any character in the inputs):
//   echo '{"name":"My Bot","desc":"Assistant for X"}' \
//     | bun run skills/slack-app-setup/scripts/build-manifest-url.ts
//
// Usage (fallback):
//   BOT_NAME="My Bot" BOT_DESC="Optional description" \
//     bun run skills/slack-app-setup/scripts/build-manifest-url.ts
//
// stdin-JSON is preferred because it pairs with a quoted shell heredoc
// (e.g. `<<'END'`) so apostrophes, quotes, backticks, $variables, etc.
// in the bot name or description cannot break shell quoting or URL encoding.
//
// Output: JSON `{ "ok": true, "data": { "url": "..." } }` on success,
//         JSON `{ "ok": false, "error": "..." }` on failure.

type Input = { name?: string; desc?: string };

let input: Input = {};
const stdinText = await Bun.stdin.text();
if (stdinText.trim()) {
  try {
    input = JSON.parse(stdinText);
  } catch (err) {
    console.error(
      JSON.stringify({
        ok: false,
        error: `Invalid JSON on stdin: ${(err as Error).message}`,
      }),
    );
    process.exit(1);
  }
}

const name = input.name ?? process.env.BOT_NAME;
const desc = input.desc ?? process.env.BOT_DESC ?? "";

if (name === undefined) {
  console.error(
    JSON.stringify({
      ok: false,
      error: 'Missing bot name. Pass {"name":"..."} on stdin or set BOT_NAME.',
    }),
  );
  process.exit(1);
}

// Slack requires display_information.name to be 1–35 characters.
const safeName = name.trim().slice(0, 35) || "My Assistant";

const manifest = {
  display_information: {
    name: safeName,
    // Slack caps `description` at 140 characters.
    ...(desc ? { description: desc.slice(0, 140) } : {}),
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
      // Slack caps `agent_description` at 300 characters.
      agent_description: (desc || safeName).slice(0, 300),
      suggested_prompts: [],
    },
  },
  oauth_config: {
    // Scopes are split required vs optional. Slack lists optional scopes
    // separately on the install consent screen, so a workspace that declines
    // one makes a visible choice instead of silently dropping it. Optional
    // means "degrades gracefully", not "unwanted".
    scopes: {
      bot: [
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
      ],
      bot_optional: [
        "channels:join",
        "files:read",
        "files:write",
        "reactions:read",
        "reactions:write",
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
      ],
      user_optional: ["search:read", "reactions:read"],
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

const url =
  "https://api.slack.com/apps?new_app=1&manifest_json=" +
  encodeURIComponent(JSON.stringify(manifest));

console.log(JSON.stringify({ ok: true, data: { url } }));
