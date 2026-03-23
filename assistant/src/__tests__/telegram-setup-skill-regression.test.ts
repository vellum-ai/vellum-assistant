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
      "same Telegram config handler used by Settings",
    );
  });

  test("keeps default command registration explicit so custom commands are preserved", () => {
    expect(skillContent).toContain(
      "If this bot already has custom commands configured and the user wants to keep them, skip this step.",
    );
    expect(skillContent).toContain(
      "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/telegram/commands",
    );
  });

  test("forbids plaintext chat-pasted Telegram bot tokens", () => {
    expect(skillContent).toContain("never accept it pasted in plaintext chat");
    expect(skillContent).toContain("always use the secure credential prompt");
  });

  test("stops setup cleanly when the secure prompt is cancelled", () => {
    expect(skillContent).toContain("prompt was cancelled");
    expect(skillContent).toContain("no bot token was saved");
  });

  test("surfaces managed callback registration failures before success", () => {
    expect(skillContent).toContain(
      "assistant platform callback-routes register --path webhooks/telegram --type telegram --json",
    );
    expect(skillContent).toContain(
      "inbound webhook delivery is not configured yet",
    );
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
  });
});
