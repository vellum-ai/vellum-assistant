import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..", "..");
const SKILL_PATH = resolve(REPO_ROOT, "skills", "slack-app-setup", "SKILL.md");

const skillContent = readFileSync(SKILL_PATH, "utf-8");

describe("slack-app-setup skill regression", () => {
  test("collects tokens through the bundled setup form, not a multi-turn chat", () => {
    expect(skillContent).toContain(
      "bun run skills/slack-app-setup/scripts/setup-form.ts",
    );
    // Tokens are entered into the form's password fields and flow straight
    // into the credential store, not gathered turn-by-turn in chat.
    expect(skillContent).toContain("travel straight to the credential store");
  });

  test("never routes secrets through chat, the model, or the model-driven ui_show tool", () => {
    expect(skillContent).toContain(
      "never pass through the chat conversation, the model, or this skill's stdout",
    );
    // The skill must not ask the user to paste tokens into the conversation...
    expect(skillContent).toContain("paste them in chat");
    // ...nor collect secrets via the model-driven `ui_show` tool. The form is
    // shown deterministically by setup-form.ts via `assistant ui request`.
    expect(skillContent).not.toContain("ui_show");
  });

  test("stores tokens through the validated Settings handler, not shell reimplementation", () => {
    expect(skillContent).toContain(
      "same Slack settings handler used by Settings",
    );
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
