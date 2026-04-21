import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..", "..");
const SKILL_PATH = resolve(REPO_ROOT, "skills", "slack-app-setup", "SKILL.md");

const skillContent = readFileSync(SKILL_PATH, "utf-8");

describe("slack-app-setup skill regression", () => {
  test("keeps Slack token collection on the secure credential prompt path", () => {
    expect(skillContent).toContain(
      '`credential_store` with `action: "prompt"`',
    );
    expect(skillContent).toContain(
      "same Slack settings handler used by Settings",
    );
  });

  test("forbids plaintext forms and chat-pasted secrets", () => {
    expect(skillContent).toContain("Do NOT use `ui_show`");
    expect(skillContent).toContain(
      "Do NOT ask the user to paste tokens in chat",
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
