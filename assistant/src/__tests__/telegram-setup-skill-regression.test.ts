import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..", "..");
const SKILL_PATH = resolve(REPO_ROOT, "skills", "telegram-setup", "SKILL.md");

const skillContent = readFileSync(SKILL_PATH, "utf-8");

describe("telegram-setup skill regression", () => {
  test("keeps Telegram bot token collection on the secure setup-handler path", () => {
    expect(skillContent).toContain(
      '`credential_store` with `action: "prompt"`',
    );
    expect(skillContent).toContain(
      "same Telegram setup handler used by Settings",
    );
  });

  test("forbids plaintext chat-pasted Telegram bot tokens", () => {
    expect(skillContent).toContain("never accept it pasted in plaintext chat");
    expect(skillContent).toContain("always use the secure credential prompt");
  });

  test("does not instruct the agent to reimplement Telegram setup in shell", () => {
    expect(skillContent).not.toContain(
      "assistant credentials reveal --service telegram",
    );
    expect(skillContent).not.toContain(
      'curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getMe"',
    );
    expect(skillContent).not.toContain(
      'curl -sf -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands"',
    );
    expect(skillContent).not.toContain(
      "assistant credentials set --service telegram --field webhook_secret",
    );
    expect(skillContent).not.toContain(
      "assistant config set telegram.botUsername",
    );
    expect(skillContent).not.toContain(
      "assistant platform callback-routes register",
    );
  });
});
