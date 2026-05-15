import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..", "..");
const SKILL_PATH = resolve(REPO_ROOT, "skills", "twilio-setup", "SKILL.md");

const skillContent = readFileSync(SKILL_PATH, "utf-8");

describe("twilio-setup skill regression", () => {
  test("keeps setup and webhook repair automation-first", () => {
    expect(skillContent).toContain("## Automation-First Rule");
    expect(skillContent).toContain(
      "Do not tell the user to paste webhook URLs into the Twilio Console on the first try",
    );
    expect(skillContent).toContain(
      "Manual Twilio Console instructions are fallback-only",
    );
    expect(skillContent).toContain(
      "Do not send the user to the Twilio Console for this repair until this update command has been attempted and failed.",
    );
  });

  test("continues to provide the automated Twilio webhook update command", () => {
    expect(skillContent).toContain("IncomingPhoneNumbers/$PHONE_SID.json");
    expect(skillContent).toContain(
      '-d "VoiceUrl=$PUBLIC_URL/webhooks/twilio/voice"',
    );
    expect(skillContent).toContain(
      '-d "StatusCallback=$PUBLIC_URL/webhooks/twilio/status"',
    );
  });

  test("does not preserve the known manual-first phrasing", () => {
    expect(skillContent).not.toContain("Here's what to plug into");
    expect(skillContent).not.toContain(
      "plug into your Twilio phone number config",
    );
  });
});
