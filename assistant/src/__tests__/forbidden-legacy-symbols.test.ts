import { describe, test, expect } from 'bun:test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Guard test: fail if any legacy Twilio ingress symbols reappear in
 * production source code. These were removed as part of the Gateway
 * Ingress Remediation (#5948). Test files, node_modules, changelogs,
 * .private/, and migration/deprecation files (config/loader.ts,
 * gateway/config.ts) are excluded since they legitimately reference
 * these strings for backward-compat migration and deprecation warnings.
 */
describe('forbidden legacy symbols', () => {
  test('no production code references removed Twilio ingress symbols', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..');
    let matches = '';
    try {
      matches = execSync(
        'rg -n "TWILIO_WEBHOOK_BASE_URL|twilioWebhookBaseUrl|twilio_webhook_config|calls\\.webhookBaseUrl"' +
        " --glob '!**/node_modules/**'" +
        " --glob '!**/__tests__/**'" +
        " --glob '!**/CHANGELOG*'" +
        " --glob '!**/.private/**'" +
        " --glob '!assistant/src/config/loader.ts'" +
        " --glob '!gateway/src/config.ts'" +
        // Compat stubs in IPC contract and handler dispatch legitimately
        // reference the deprecated symbol to keep version-skewed clients working.
        " --glob '!**/ipc-contract.ts'" +
        " --glob '!**/handlers/index.ts'",
        { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err: unknown) {
      // rg exits with code 1 when no matches are found — that is the expected (passing) case
      const exitCode = (err as { status?: number }).status;
      if (exitCode === 1) {
        // No matches found — test passes
        return;
      }
      // Any other error is unexpected
      throw err;
    }

    // If we reach here, rg found matches (exit code 0) — fail the test
    expect(matches.trim()).toBe(
      '', // should be empty — if not, the matched lines appear in the failure message
    );
  });
});
