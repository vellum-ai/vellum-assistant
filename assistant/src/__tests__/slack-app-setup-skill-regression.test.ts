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

  test("verifies on the wizard-closed auto-notify instead of manual confirmation", () => {
    // Step 2 must promise the auto-notify rather than asking the user to
    // report back...
    expect(skillContent).toContain(
      "The wizard will auto-notify me when you close it",
    );
    expect(skillContent).not.toContain("let me know when you're done");
    // ...and Step 3 must trigger on the notification, keyed to the exact
    // marker the web client sends on drawer close (see
    // `clients/web/src/domains/chat/channel-setup-close-notify.ts`).
    expect(skillContent).toContain("wizard-closed notification");
    expect(skillContent).toContain(
      "[User action on channel_setup surface: closed the slack setup wizard]",
    );
    // Phone-sized clients open the setup on the Contacts page, which cannot
    // auto-notify on completion — the client signals the relocation with a
    // hand-off marker and the skill must react by asking the user to report
    // back instead of waiting for a wizard-closed notification.
    expect(skillContent).toContain(
      "[User action on channel_setup surface: moved the slack setup to the Contacts page]",
    );
    expect(skillContent).toContain("Hand-off notification");
  });

  test("retains the Settings clearing path", () => {
    expect(skillContent).toContain(
      "same Slack settings handler used by Settings",
    );
  });
});
