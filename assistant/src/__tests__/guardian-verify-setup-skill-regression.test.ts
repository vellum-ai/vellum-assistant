/**
 * Regression tests for the guardian-verify-setup SKILL.md voice path.
 *
 * Ensures the voice verification flow includes proactive auto-check polling
 * so the user never has to manually ask whether verification succeeded.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

const ASSISTANT_DIR = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(ASSISTANT_DIR, '..');

const EMBEDDED_SKILL = resolve(
  ASSISTANT_DIR,
  'src',
  'config',
  'vellum-skills',
  'guardian-verify-setup',
  'SKILL.md',
);

const TOPLEVEL_SKILL = resolve(
  REPO_ROOT,
  'skills',
  'guardian-verify-setup',
  'SKILL.md',
);

function loadSkill(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('guardian-verify-setup SKILL.md — voice auto-followup regression', () => {
  for (const [label, skillPath] of [
    ['embedded', EMBEDDED_SKILL],
    ['top-level', TOPLEVEL_SKILL],
  ] as const) {
    describe(`${label} copy`, () => {
      const content = loadSkill(skillPath);

      test('voice path contains Step 3a auto-check/poll section', () => {
        expect(content).toContain('Step 3a: Voice Auto-Check');
      });

      test('voice auto-check polls the guardian status endpoint', () => {
        expect(content).toContain(
          '/v1/integrations/guardian/status?channel=voice',
        );
      });

      test('voice auto-check specifies polling interval (~15 seconds)', () => {
        expect(content).toMatch(/every\s+~?15\s+seconds/i);
      });

      test('voice auto-check specifies a 2-minute timeout', () => {
        expect(content).toMatch(/up\s+to\s+2\s+minutes/i);
      });

      test('voice auto-check detects bound: true and confirms proactively', () => {
        expect(content).toContain('bound: true');
        expect(content).toMatch(/proactively\s+(confirm|inform|send|tell)/i);
      });

      test('voice auto-check handles timeout with resend/restart offer', () => {
        expect(content).toMatch(/poll\s+times?\s+out/i);
        expect(content).toMatch(/resend|restart|new\s+verification/i);
      });

      test('Step 3 voice success path instructs proceeding to auto-check', () => {
        // The voice bullet in Step 3 "On success" must reference Step 3a
        const step3SuccessMatch = content.match(
          /### On success[\s\S]*?### Step 3a/,
        );
        expect(step3SuccessMatch).not.toBeNull();

        const step3SuccessBlock = step3SuccessMatch![0];
        // Voice entry must tell the assistant to proceed to Step 3a
        expect(step3SuccessBlock).toContain('Step 3a: Voice Auto-Check');
      });

      test('Step 4 voice resend path instructs proceeding to auto-check', () => {
        // The voice bullet in Step 4 must also reference Step 3a
        const step4Match = content.match(
          /## Step 4: Handle Resend[\s\S]*?## Step 5/,
        );
        expect(step4Match).not.toBeNull();

        const step4Block = step4Match![0];
        expect(step4Block).toContain('Step 3a: Voice Auto-Check');
      });

      test('voice path does NOT instruct waiting for user to ask "did it work?"', () => {
        // The voice sections should never tell the assistant to passively wait
        // for the user to report whether verification succeeded. Phrases like
        // "Do NOT wait for the user to ask" are fine -- they are prohibitions.
        // We only flag affirmative instructions to wait.
        const voiceAutoCheckSection = content.match(
          /### Step 3a: Voice Auto-Check[\s\S]*?### On error/,
        );
        expect(voiceAutoCheckSection).not.toBeNull();

        const autoCheckBlock = voiceAutoCheckSection![0];

        // Strip lines containing "do NOT wait" or "don't wait" (prohibitions
        // are the desired behavior, not violations).
        const withoutProhibitions = autoCheckBlock
          .split('\n')
          .filter(
            (line) =>
              !/do\s+not\s+wait/i.test(line) && !/don't\s+wait/i.test(line),
          )
          .join('\n');

        // After removing prohibition lines, there should be no remaining
        // instruction telling the assistant to wait for user confirmation.
        expect(withoutProhibitions).not.toMatch(
          /wait\s+for\s+(the\s+)?user\s+to\s+(ask|report|confirm|tell)/i,
        );
      });

      test('SMS and Telegram paths are unchanged (no auto-check reference)', () => {
        // SMS bullet in Step 3 success should NOT mention Step 3a
        const smsLine = content.match(
          /- \*\*SMS\*\*:.*?verification.*?SMS channel\."/,
        );
        expect(smsLine).not.toBeNull();
        expect(smsLine![0]).not.toContain('Step 3a');

        // Telegram bullet should NOT mention Step 3a
        const telegramLine = content.match(
          /- \*\*Telegram with chat ID\*\*.*?Step 3/,
        );
        expect(telegramLine).not.toBeNull();
        // The only "Step 3" reference in the Telegram line should be
        // "retry from Step 3", not "Step 3a"
        expect(telegramLine![0]).not.toContain('Step 3a');
      });
    });
  }
});
