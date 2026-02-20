import { describe, test, expect } from 'bun:test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Guard test: fail if any legacy Twilio ingress symbols reappear in
 * production source code. These were removed as part of the Gateway
 * Ingress Remediation (#5948). Test files, node_modules, changelogs,
 * and .private/ are excluded.
 */
describe('forbidden legacy symbols', () => {
  test('no production code references removed Twilio ingress symbols', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..');
    let matches = '';
    try {
      matches = execSync(
        'grep -rn -E "TWILIO_WEBHOOK_BASE_URL|twilioWebhookBaseUrl|twilio_webhook_config|calls\\.webhookBaseUrl"' +
        ' --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" --include="*.swift" --include="*.json" --include="*.md" --include="*.yml" --include="*.yaml"' +
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
