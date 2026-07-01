import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..", "..");
const SKILL_PATH = resolve(REPO_ROOT, "skills", "slack-app-setup", "SKILL.md");

const skillContent = readFileSync(SKILL_PATH, "utf-8");

describe("slack-app-setup skill regression", () => {
  test("uses the channel_setup wizard surface for token entry", () => {
    expect(skillContent).toContain('surface_type: "channel_setup"');
    expect(skillContent).toContain("ui_show");
  });

  test("forbids plaintext token collection in chat", () => {
    expect(skillContent).toContain("Do NOT collect tokens in chat");
    expect(skillContent).toContain(
      "Do NOT ask the user to paste tokens into the conversation",
    );
  });

  test("does not instruct the agent to reveal or manually store credentials", () => {
    expect(skillContent).not.toContain(
      "assistant credentials reveal --service slack_channel",
    );
    expect(skillContent).not.toContain("assistant config set slack.teamId");
    expect(skillContent).not.toContain("assistant config set slack.teamName");
    expect(skillContent).not.toContain("assistant config set slack.botUserId");
    expect(skillContent).not.toContain(
      "assistant config set slack.botUsername",
    );
  });

  test("retains the Settings clearing path", () => {
    expect(skillContent).toContain(
      "same Slack settings handler used by Settings",
    );
  });
});
