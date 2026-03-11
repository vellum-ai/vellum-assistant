/**
 * Regression tests for the guardian-verify-setup skill.
 *
 * Ensures the voice verification flow includes proactive auto-check polling
 * so the user does not have to manually ask whether verification succeeded.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("guardian-verify-setup skill — voice auto-followup", () => {
  test("voice path in Step 3 references the auto-check polling loop", () => {
    // The voice success instruction in Step 3 must direct the assistant to
    // begin the polling loop rather than waiting for the user to report back.
    expect(skillContent).toContain(
      "immediately begin the voice auto-check polling loop",
    );
  });

  test("voice path in Step 4 (resend) references the auto-check polling loop", () => {
    // After a voice resend, the same auto-check behavior must kick in.
    const resendSection =
      skillContent.split("## Step 4")[1]?.split("## Step 5")[0] ?? "";
    expect(resendSection).toContain("voice auto-check polling loop");
  });

  test("contains a Voice Auto-Check Polling section", () => {
    expect(skillContent).toContain("## Voice Auto-Check Polling");
  });

  test("polling section specifies the correct status command for voice", () => {
    const pollingSection =
      skillContent
        .split("## Voice Auto-Check Polling")[1]
        ?.split("## Step 6")[0] ?? "";
    expect(pollingSection).toContain(
      "assistant channel-verification-sessions status --channel phone --json",
    );
  });

  test("polling section includes ~15 second interval", () => {
    const pollingSection =
      skillContent
        .split("## Voice Auto-Check Polling")[1]
        ?.split("## Step 6")[0] ?? "";
    expect(pollingSection).toContain("~15 seconds");
  });

  test("polling section includes 2-minute timeout", () => {
    const pollingSection =
      skillContent
        .split("## Voice Auto-Check Polling")[1]
        ?.split("## Step 6")[0] ?? "";
    expect(pollingSection).toContain("2 minutes");
  });

  test("polling section checks for bound: true", () => {
    const pollingSection =
      skillContent
        .split("## Voice Auto-Check Polling")[1]
        ?.split("## Step 6")[0] ?? "";
    expect(pollingSection).toContain("bound: true");
  });

  test("polling section includes proactive success confirmation", () => {
    const pollingSection =
      skillContent
        .split("## Voice Auto-Check Polling")[1]
        ?.split("## Step 6")[0] ?? "";
    expect(pollingSection).toContain("proactive success message");
  });

  test("polling section includes timeout fallback with resend/restart offer", () => {
    const pollingSection =
      skillContent
        .split("## Voice Auto-Check Polling")[1]
        ?.split("## Step 6")[0] ?? "";
    expect(pollingSection).toContain("timeout");
    expect(pollingSection).toContain("resend");
  });

  test("polling section includes rebind guard against false-success from pre-existing binding", () => {
    const pollingSection =
      skillContent
        .split("## Voice Auto-Check Polling")[1]
        ?.split("## Step 6")[0] ?? "";
    // Must mention rebind guard concept
    expect(pollingSection).toContain("Rebind guard");
    // Must instruct not to trust bound: true alone in a rebind flow
    expect(pollingSection).toContain(
      "do NOT treat `bound: true` alone as success",
    );
    // Must reference verificationSessionId as the mechanism to detect fresh binding
    expect(pollingSection).toContain("verificationSessionId");
    // Must clarify non-rebind flows are unaffected
    expect(pollingSection).toContain("Non-rebind flows");
  });

  test("polling is voice-only — does not apply to Telegram", () => {
    const pollingSection =
      skillContent
        .split("## Voice Auto-Check Polling")[1]
        ?.split("## Step 6")[0] ?? "";
    expect(pollingSection).toContain("voice-only");
    expect(pollingSection).toContain("Do NOT poll for Telegram");
  });

  test('no instruction requires waiting for user to ask "did it work?"', () => {
    // The skill should never instruct the assistant to wait for the user to
    // confirm that voice verification worked. The auto-check polling loop
    // makes this unnecessary.
    const voiceAutoCheckSection =
      skillContent
        .split("## Voice Auto-Check Polling")[1]
        ?.split("## Step 6")[0] ?? "";
    expect(voiceAutoCheckSection).toContain("Do NOT require the user to ask");
    // The voice bullet in Step 3 should not instruct the assistant to wait
    // for the user to confirm or ask if it worked. Narrow to just the voice
    // bullet line to avoid false positives from Telegram's "wait for the
    // user to confirm they clicked the link" which is unrelated to voice.
    const step3Section =
      skillContent.split("## Step 3")[1]?.split("## Step 4")[0] ?? "";
    const voiceBullet = step3Section
      .split("\n")
      .filter((line) => /^\s*-\s+\*\*Phone\*\*/.test(line))
      .join("\n");
    expect(voiceBullet).not.toHaveLength(0);
    expect(voiceBullet).not.toContain("wait for the user to confirm");
    expect(voiceBullet).not.toContain("ask the user if it worked");
  });
});
