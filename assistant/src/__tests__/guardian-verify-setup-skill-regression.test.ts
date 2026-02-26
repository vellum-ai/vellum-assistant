/**
 * Regression tests for the guardian-verify-setup skill.
 *
 * Ensures the voice verification flow includes proactive auto-check polling
 * so the user does not have to manually ask whether verification succeeded.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Locate the skill SKILL.md
// ---------------------------------------------------------------------------

const ASSISTANT_DIR = resolve(import.meta.dirname ?? __dirname, '..', '..');
const SKILL_PATH = resolve(
  ASSISTANT_DIR,
  'src',
  'config',
  'vellum-skills',
  'guardian-verify-setup',
  'SKILL.md',
);

const skillContent = readFileSync(SKILL_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('guardian-verify-setup skill — voice auto-followup', () => {
  test('voice path in Step 3 references the auto-check polling loop', () => {
    // The voice success instruction in Step 3 must direct the assistant to
    // begin the polling loop rather than waiting for the user to report back.
    expect(skillContent).toContain(
      'immediately begin the voice auto-check polling loop',
    );
  });

  test('voice path in Step 4 (resend) references the auto-check polling loop', () => {
    // After a voice resend, the same auto-check behavior must kick in.
    const resendSection = skillContent.split('## Step 4')[1]?.split('## Step 5')[0] ?? '';
    expect(resendSection).toContain(
      'voice auto-check polling loop',
    );
  });

  test('contains a Voice Auto-Check Polling section', () => {
    expect(skillContent).toContain('## Voice Auto-Check Polling');
  });

  test('polling section specifies the correct status endpoint for voice', () => {
    const pollingSection =
      skillContent.split('## Voice Auto-Check Polling')[1]?.split('## Step 6')[0] ?? '';
    expect(pollingSection).toContain(
      '/v1/integrations/guardian/status?channel=voice',
    );
  });

  test('polling section includes ~15 second interval', () => {
    const pollingSection =
      skillContent.split('## Voice Auto-Check Polling')[1]?.split('## Step 6')[0] ?? '';
    expect(pollingSection).toContain('~15 seconds');
  });

  test('polling section includes 2-minute timeout', () => {
    const pollingSection =
      skillContent.split('## Voice Auto-Check Polling')[1]?.split('## Step 6')[0] ?? '';
    expect(pollingSection).toContain('2 minutes');
  });

  test('polling section checks for bound: true', () => {
    const pollingSection =
      skillContent.split('## Voice Auto-Check Polling')[1]?.split('## Step 6')[0] ?? '';
    expect(pollingSection).toContain('bound: true');
  });

  test('polling section includes proactive success confirmation', () => {
    const pollingSection =
      skillContent.split('## Voice Auto-Check Polling')[1]?.split('## Step 6')[0] ?? '';
    expect(pollingSection).toContain('proactive success message');
  });

  test('polling section includes timeout fallback with resend/restart offer', () => {
    const pollingSection =
      skillContent.split('## Voice Auto-Check Polling')[1]?.split('## Step 6')[0] ?? '';
    expect(pollingSection).toContain('timeout');
    expect(pollingSection).toContain('resend');
  });

  test('polling is voice-only — does not apply to SMS or Telegram', () => {
    const pollingSection =
      skillContent.split('## Voice Auto-Check Polling')[1]?.split('## Step 6')[0] ?? '';
    expect(pollingSection).toContain('voice-only');
    expect(pollingSection).toContain('Do NOT poll for SMS or Telegram');
  });

  test('no instruction requires waiting for user to ask "did it work?"', () => {
    // The skill should never instruct the assistant to wait for the user to
    // confirm that voice verification worked. The auto-check polling loop
    // makes this unnecessary.
    const voiceAutoCheckSection =
      skillContent.split('## Voice Auto-Check Polling')[1]?.split('## Step 6')[0] ?? '';
    expect(voiceAutoCheckSection).toContain(
      'Do NOT require the user to ask',
    );
    // There should be no phrase like "wait for the user to confirm" or
    // "ask the user if it worked" in the voice-related sections.
    const step3VoiceLine = skillContent
      .split('## Step 3')[1]
      ?.split('## Step 4')[0] ?? '';
    expect(step3VoiceLine).not.toContain('wait for the user to confirm');
    expect(step3VoiceLine).not.toContain('ask the user if it worked');
  });
});
