import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..", "..");
const SKILL_PATH = resolve(REPO_ROOT, "skills", "slack-app-setup", "SKILL.md");

const skillContent = readFileSync(SKILL_PATH, "utf-8");

describe("slack-app-setup skill regression", () => {
  test("uses the channel_setup surface to open the wizard", () => {
    expect(skillContent).toContain("channel_setup");
    expect(skillContent).toContain("ui_show");
    expect(skillContent).toContain('"channel": "slack"');
  });

  test("tokens are collected via the wizard, never in chat", () => {
    expect(skillContent).toContain(
      "tokens go from input fields directly to the API, never through the conversation",
    );
    expect(skillContent).toContain("Do not collect tokens in chat");
  });

  test("verifies credentials after user completes wizard", () => {
    expect(skillContent).toContain("assistant credentials list");
    expect(skillContent).toContain("app_token");
    expect(skillContent).toContain("bot_token");
  });

  test("uses the settings handler for clearing credentials", () => {
    expect(skillContent).toContain(
      "same Slack settings handler used by Settings",
    );
  });

  test("does not instruct the agent to reimplement Slack validation in shell", () => {
    expect(skillContent).not.toContain(
      "assistant credentials reveal --service slack_channel",
    );
    expect(skillContent).not.toContain(
      'curl -sf -X POST "https://slack.com/api/auth.test"',
    );
    expect(skillContent).not.toContain("assistant config set slack.teamId");
    expect(skillContent).not.toContain("assistant config set slack.teamName");
    expect(skillContent).not.toContain("assistant config set slack.botUserId");
    expect(skillContent).not.toContain(
      "assistant config set slack.botUsername",
    );
  });
});
