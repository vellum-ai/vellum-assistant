/**
 * Generates a pre-filled Slack app manifest creation URL.
 *
 * Usage:
 *   bun skills/slack-app-setup/generate-manifest-url.ts
 *   bun skills/slack-app-setup/generate-manifest-url.ts <bot-name> [bot-description]
 *
 * The manifest is the single source of truth for all required scopes,
 * event subscriptions, and settings.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_ASSISTANT_NAME = "Vellum Assistant";
const DEFAULT_GUARDIAN_NAME = "User";

function cleanField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("_(") && trimmed.endsWith(")_")) return undefined;
  return trimmed;
}

function labelPattern(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^-\\s*(?:\\*\\*)?${escaped}:?(?:\\*\\*)?\\s*(.+)$`, "i");
}

function readFirstMarkdownField(
  path: string,
  labels: string[],
): string | undefined {
  if (!existsSync(path)) return undefined;

  const content = readFileSync(path, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    for (const label of labels) {
      const match = line.match(labelPattern(label));
      const value = cleanField(match?.[1]);
      if (value) return value;
    }
  }

  return undefined;
}

function getWorkspaceDir(): string {
  return process.env.VELLUM_WORKSPACE_DIR?.trim() || process.cwd();
}

function inferAssistantName(workspaceDir: string): string {
  return (
    readFirstMarkdownField(join(workspaceDir, "IDENTITY.md"), [
      "Name",
      "Assistant Name",
      "Preferred Name",
    ]) ||
    cleanField(process.env.VELLUM_ASSISTANT_NAME) ||
    DEFAULT_ASSISTANT_NAME
  );
}

function inferGuardianName(workspaceDir: string): string {
  return (
    readFirstMarkdownField(join(workspaceDir, "users", "default.md"), [
      "Name",
      "Preferred name/reference",
      "Preferred Name",
    ]) ||
    readFirstMarkdownField(join(workspaceDir, "USER.md"), [
      "Name",
      "Preferred name/reference",
      "Preferred Name",
    ]) ||
    DEFAULT_GUARDIAN_NAME
  );
}

const workspaceDir = getWorkspaceDir();
const name = cleanField(process.argv[2]) ?? inferAssistantName(workspaceDir);
const desc =
  process.argv[3] !== undefined
    ? (cleanField(process.argv[3]) ?? "")
    : `${inferGuardianName(workspaceDir)}'s Assistant`;

const manifest = {
  display_information: {
    name,
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
      display_name: name,
      always_online: true,
    },
    assistant_view: {
      assistant_description: desc || name,
      suggested_prompts: [],
    },
  },
  oauth_config: {
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
