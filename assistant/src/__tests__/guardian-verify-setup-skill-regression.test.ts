/**
 * Regression tests for the guardian-verify-setup skill.
 *
 * The behaviour under guard is proactive auto-check polling: after a code is
 * delivered, the skill must poll for completion rather than leaving the user
 * to ask whether it worked. Originally that existed only for voice, and these
 * tests pinned the voice section. The three per-channel polling sections were
 * later merged into one parameterised section, so the assertions here pin the
 * behaviour in its shared form and cover every channel that polls.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Locate the skill SKILL.md
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..", "..");
const SKILL_PATH = resolve(
  REPO_ROOT,
  "skills",
  "guardian-verify-setup",
  "SKILL.md",
);

const skillContent = readFileSync(SKILL_PATH, "utf-8");

/**
 * The channels that poll. Telegram is deliberately absent: it confirms through
 * its own bot-driven flow, so polling it reports nothing.
 */
const POLLED_CHANNELS = ["phone", "slack", "discord", "email"] as const;

function section(from: string, to: string): string {
  const body = skillContent.split(from)[1]?.split(to)[0];
  // An empty slice would make every `toContain` below fail loudly rather than
  // silently pass, which is the intent: a renamed heading must break this.
  return body ?? "";
}

const pollingSection = () => section("## Auto-Check Polling", "## Step 6");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("guardian-verify-setup skill: proactive auto-check polling", () => {
  test("the polling section exists", () => {
    expect(skillContent).toContain("## Auto-Check Polling");
  });

  test("Step 3 sends every polled channel into the loop", () => {
    const step3 = section("## Step 3", "## Step 4");
    for (const channel of POLLED_CHANNELS) {
      const bullet = step3
        .split("\n")
        .filter((line) =>
          new RegExp(
            `^\\s*-\\s+\\*\\*(Phone|Slack|Discord|Email)\\*\\*`,
            "i",
          ).test(line),
        )
        .find((line) => new RegExp(channel, "i").test(line));
      expect(bullet, `Step 3 has no bullet for ${channel}`).toBeDefined();
      expect(bullet).toContain("auto-check polling loop");
    }
  });

  test("Step 4 resend sends every polled channel back into the loop", () => {
    const resend = section("## Step 4", "## Step 5");
    for (const channel of POLLED_CHANNELS) {
      expect(
        new RegExp(`\\*\\*${channel}\\*\\*`, "i").test(resend),
        `Step 4 has no bullet for ${channel}`,
      ).toBe(true);
    }
    expect(resend).toContain("auto-check polling loop");
  });

  test("the polling section names every polled channel and excludes Telegram", () => {
    const body = pollingSection();
    for (const channel of POLLED_CHANNELS) {
      expect(body, `polling section omits ${channel}`).toContain(channel);
    }
    // Telegram may only appear as an exclusion, never as a channel to poll.
    expect(body).toContain("Never Telegram");
  });

  test("the polling command is guarded against an unset channel", () => {
    const body = pollingSection();
    // The command is parameterised, so the channel has to be assigned in the
    // same block. An unset CHANNEL would call the CLI with an empty value.
    expect(body).toContain('CHANNEL=""');
    expect(body).toContain('if [ -z "$CHANNEL" ]');
    expect(body).toContain(
      'channel-verification-sessions status --channel "$CHANNEL" --json',
    );
  });

  test("the polling section states an interval and a timeout per channel", () => {
    const body = pollingSection();
    expect(body).toContain("15s");
    expect(body).toContain("20s");
    expect(body).toContain("2 minutes");
    expect(body).toContain("3 minutes");
  });

  test("the polling section checks for bound: true", () => {
    expect(pollingSection()).toContain("bound: true");
  });

  test("success is reported proactively, not on request", () => {
    const body = pollingSection();
    expect(body).toContain("success message");
    expect(body).toContain("Do NOT require the user to ask");
  });

  test("timeout offers a resend rather than stopping silently", () => {
    const body = pollingSection();
    expect(body).toContain("timeout");
    expect(body).toContain("resend");
  });

  test("the rebind guard survives, with its false-success reasoning", () => {
    const body = pollingSection();
    expect(body).toContain("Rebind guard");
    expect(body).toContain("verificationSessionId");
    expect(body).toContain("Non-rebind flows");
  });

  test("no polled channel's Step 3 bullet tells the assistant to wait", () => {
    const step3 = section("## Step 3", "## Step 4");
    // Narrowed to the polled bullets: Telegram's "wait for the user to confirm
    // they clicked the link" is a real instruction for its own bootstrap flow.
    const bullets = step3
      .split("\n")
      .filter((line) =>
        /^\s*-\s+\*\*(Phone|Slack|Discord|Email)\*\*/i.test(line),
      );
    expect(bullets.length).toBe(POLLED_CHANNELS.length);
    for (const bullet of bullets) {
      expect(bullet).not.toContain("wait for the user to confirm");
      expect(bullet).not.toContain("ask the user if it worked");
    }
  });
});

describe("guardian-verify-setup skill: channel coverage", () => {
  test("every channel the CLI accepts is offered in Step 1", () => {
    const step1 = section("## Step 1", "## Step 2");
    for (const channel of [...POLLED_CHANNELS, "telegram"]) {
      expect(step1, `Step 1 does not offer ${channel}`).toContain(
        `**${channel}**`,
      );
    }
  });

  test("Step 2 collects a destination for every channel", () => {
    const step2 = section("## Step 2", "## Step 3");
    for (const channel of ["Phone", "Telegram", "Slack", "Discord", "Email"]) {
      expect(step2, `Step 2 has no destination for ${channel}`).toContain(
        `**${channel}**`,
      );
    }
  });

  test("the missing-secret guardrail names only its exception", () => {
    const guardrail = skillContent
      .split("\n")
      .find((line) => line.includes("Missing `secret` guardrail"));
    expect(guardrail).toBeDefined();
    // The rule covers every flow but one, so the line states that exception.
    // Naming any other channel makes it an enumeration, and an enumeration
    // drifts out of date the next time a channel is added.
    expect(guardrail).toContain("except");
    expect(guardrail).toContain("Telegram");
    const lower = guardrail!.toLowerCase();
    for (const channel of ["phone", "voice", "slack", "discord", "email"]) {
      expect(lower, `guardrail enumerates ${channel}`).not.toContain(channel);
    }
  });

  test("the status and revoke guards allow every supported channel", () => {
    // These enumerate valid CHANNEL values. A channel missing here reads to
    // the assistant as unsupported at exactly the point a user asks for it.
    const guards = skillContent
      .split("\n")
      .filter((line) => line.includes("MUST set to one of"));
    expect(guards.length).toBeGreaterThanOrEqual(2);
    for (const guard of guards) {
      expect(guard).toContain("discord");
    }
  });
});
