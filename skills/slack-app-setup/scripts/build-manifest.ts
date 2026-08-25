#!/usr/bin/env bun
// Builds a Slack app manifest.
//
// Usage (preferred — robust to any character in the inputs):
//   echo '{"name":"My Bot","desc":"Assistant for X"}' \
//     | bun run skills/slack-app-setup/scripts/build-manifest.ts
//
// Usage (fallback):
//   BOT_NAME="My Bot" BOT_DESC="Optional description" \
//     bun run skills/slack-app-setup/scripts/build-manifest.ts
//
// stdin-JSON is preferred because it pairs with a quoted shell heredoc
// (e.g. `<<'END'`) so apostrophes, quotes, backticks, $variables, etc.
// in the bot name or description cannot break shell quoting or URL encoding.
//
// Output: JSON `{ "ok": true, "data": { "manifest": {...} } }` on success,
//         JSON `{ "ok": false, "error": "..." }` on failure.
//
// Slack's create-app modal takes a manifest under "From a manifest" and
// ignores the `manifest_json` query parameter, so the JSON reaches Slack by
// hand — through the clipboard in the wizard — rather than through a link.

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
    // `agent_view` drives the Agent messaging experience. It declares
    // `additionalProperties: false` and names its description
    // `agent_description`, so an `assistant_description` key is rejected.
    // Slack treats the switch away from `assistant_view` as one-way.
    agent_view: {
      // Slack caps `agent_description` at 300 characters.
      agent_description: (desc || safeName).slice(0, 300),
      suggested_prompts: [],
    },
  },
  oauth_config: {
    // `bot`/`user` carry the complete request; `bot_optional`/`user_optional`
    // mark the subset a workspace may decline on the consent screen. An
    // optional entry must also appear in its parent list — a scope named only
    // in the optional array is never requested.
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
        "reactions:read",
        "search:read",
        "users:read",
      ],
      user_optional: ["reactions:read", "search:read"],
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
        "reaction_removed",
      ],
    },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

console.log(JSON.stringify({ ok: true, data: { manifest } }));
