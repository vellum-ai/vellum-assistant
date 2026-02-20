import { describe, test, expect } from 'bun:test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Guard test: fail if any legacy Twilio ingress symbols reappear in
 * production source code, docs, configs, or scripts.
 *
 * Context: As part of the gateway-only ingress migration (#5948, #6000),
 * all Twilio webhook configuration was consolidated into the gateway service.
 * The assistant no longer manages its own Twilio webhook URLs — the gateway
 * is the single ingress point for all telephony webhooks. Re-introducing
 * these symbols in the assistant would bypass that architecture and create
 * a split-brain ingress problem.
 *
 * Forbidden symbols:
 *   - TWILIO_WEBHOOK_BASE_URL  — legacy env var for direct Twilio webhook base
 *   - twilioWebhookBaseUrl     — camelCase variant used in runtime config
 *   - twilio_webhook_config    — legacy config object key
 *   - calls.webhookBaseUrl     — nested config path for call webhook URL
 *
 * Excluded directories:
 *   - node_modules  — third-party code, not under our control
 *   - __tests__     — test files (including this guard test) reference the
 *                     symbols in grep patterns and assertions
 *   - .private      — local-only developer notes and scratch files
 */
describe('forbidden legacy symbols', () => {
  test('no production code references removed Twilio ingress symbols', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..');
    let matches = '';
    try {
      matches = execSync(
        'grep -rn -E "TWILIO_WEBHOOK_BASE_URL|twilioWebhookBaseUrl|twilio_webhook_config|calls\\.webhookBaseUrl"' +
        ' --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" --include="*.swift"' +
        ' --include="*.json" --include="*.md" --include="*.yml" --include="*.yaml"' +
        ' --include="*.sh" --include="*.env" --include="*.env.*"' +
        ' --exclude-dir=node_modules --exclude-dir=__tests__ --exclude-dir=.private' +
        ' .',
        { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err: unknown) {
      // grep exits with code 1 when no matches are found — that is the expected (passing) case
      const exitCode = (err as { status?: number }).status;
      if (exitCode === 1) {
        // No matches found — test passes
        return;
      }
      // Any other error is unexpected
      throw err;
    }

    // If we reach here, grep found matches (exit code 0) — fail the test
    expect(matches.trim()).toBe(
      '', // should be empty — if not, the matched lines appear in the failure message
    );
  });
});
