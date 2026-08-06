import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { TELEGRAM_BOT_COMMANDS } from "./commands.js";

const REPO_ROOT = join(import.meta.dir, "../../..");
const TELEGRAM_SETUP_SKILL = join(REPO_ROOT, "skills/telegram-setup/SKILL.md");
const GATEWAY_README = join(REPO_ROOT, "gateway/README.md");

/** Slash commands that require the verified Telegram guardian. */
export const TELEGRAM_GUARDIAN_SLASH_COMMANDS = [
  "stop",
  "fork",
  "rename",
  "archive",
  "profile",
  "access",
] as const;

describe("telegram slash command policy", () => {
  test("registered bot commands partition into public and guardian-only sets", () => {
    const registered = TELEGRAM_BOT_COMMANDS.map((entry) => entry.command);
    expect(registered).toEqual([
      "new",
      ...TELEGRAM_GUARDIAN_SLASH_COMMANDS,
      "help",
    ]);
    expect(registered).not.toContain("start");
    for (const command of ["new", "help"] as const) {
      expect(TELEGRAM_GUARDIAN_SLASH_COMMANDS).not.toContain(command);
    }
    for (const command of TELEGRAM_GUARDIAN_SLASH_COMMANDS) {
      expect(registered).toContain(command);
    }
  });

  test("telegram-setup SKILL.md documents guardian-only commands and excludes /new", () => {
    const skill = readFileSync(TELEGRAM_SETUP_SKILL, "utf-8");
    expect(skill).toContain(
      "All slash commands except `/help`, `/start`, and `/new` require the verified Telegram guardian",
    );
    expect(skill).toContain(
      "`/stop`, `/fork`, `/rename`, `/archive`, `/profile`, `/access`",
    );
    expect(skill).toContain(
      "`/new` starts a fresh Vellum conversation in the current chat or topic",
    );
    expect(skill).not.toMatch(/\/new.*guardian-only/i);
  });

  test("gateway README matches the guardian slash-command policy", () => {
    const readme = readFileSync(GATEWAY_README, "utf-8");
    expect(readme).toContain(
      "all except `/help`, `/start`, and `/new` require the verified Telegram guardian (`/stop`, `/fork`, `/rename`, `/archive`, `/profile`, `/access`)",
    );
  });
});
