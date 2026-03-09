import { execSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

/**
 * Guard test: production files and skills must not reference direct runtime
 * URLs (localhost:7821, 127.0.0.1:7821, or RUNTIME_HTTP_PORT-derived URLs
 * used for external API consumption).
 *
 * The gateway is the single point of API ingress for clients, CLI, skills,
 * and user-facing tooling. See AGENTS.md "Gateway-Only API Consumption".
 *
 * Allowlist entries should be kept minimal — add a path here only if the
 * file genuinely needs to reference the runtime port directly (e.g., gateway
 * internals, daemon-control paths, or tests).
 */

/** Files that are permitted to contain direct runtime URL patterns. */
const ALLOWLIST = new Set([
  // --- Test files are always allowed (matched by directory/suffix below) ---

  // --- Gateway internals (gateway calls runtime directly) ---
  // Matched by prefix check below: gateway/

  // --- Intentional local daemon-control paths ---
  "clients/shared/IPC/DaemonClient.swift",
  "clients/macos/vellum-assistant/App/AppDelegate.swift",
  "clients/macos/vellum-assistant/Features/Settings/SettingsConnectTab.swift",
  ".claude/skills/update/SKILL.md", // daemon health check script

  // --- Test fixtures that poll the daemon directly (gateway may require auth) ---
  "playwright/agent/fixtures.ts", // daemon health-check during test setup

  // --- Chrome extension (local relay communication, not gateway API consumption) ---
  "clients/chrome-extension/background/worker.ts",
  "clients/chrome-extension/popup/popup.ts",

  // --- Documentation and comments that mention the port for explanatory purposes ---
  "AGENTS.md", // documents the gateway-only rule itself
  "ARCHITECTURE.md", // architecture overview with port references
  "assistant/docs/runbook-trusted-contacts.md", // operator runbook targeting runtime-only /v1/contacts endpoints
  "assistant/src/runtime/middleware/twilio-validation.ts", // comment explaining proxy URL rewriting
]);

/** Patterns that indicate a direct runtime URL reference via hardcoded port. */
const HARDCODED_PORT_PATTERNS = ["localhost:7821", "127\\.0\\.0\\.1:7821"];

/**
 * Pattern that catches RUNTIME_HTTP_PORT used in URL construction.
 * Matches lines containing both an http:// URL and RUNTIME_HTTP_PORT,
 * e.g. `http://localhost:${RUNTIME_HTTP_PORT}` or
 *      `"http://127.0.0.1:" + RUNTIME_HTTP_PORT`.
 *
 * Uses two alternations to handle either ordering on the same line.
 */
const RUNTIME_PORT_URL_PATTERN =
  "http://.*RUNTIME_HTTP_PORT|RUNTIME_HTTP_PORT.*http://";

/**
 * Pattern that catches localhost/loopback /v1 URLs built with an interpolated
 * port variable (e.g. `http://localhost:${port}/v1/...`).
 */
const INTERPOLATED_LOCALHOST_V1_PATTERN =
  "http://(localhost|127\\.0\\.0\\.1):\\$\\{[^}]+\\}/v1/";

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("/__tests__/") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.js") ||
    filePath.endsWith(".spec.ts") ||
    filePath.endsWith(".spec.js") ||
    filePath.includes("Tests/") ||
    filePath.endsWith("Tests.swift")
  );
}

function isGatewayInternal(filePath: string): boolean {
  return filePath.startsWith("gateway/");
}

/** Shared violation filter: exempt test files, gateway internals, and allowlisted paths. */
function filterViolations(files: string[]): string[] {
  return files.filter((f) => {
    if (isTestFile(f)) return false;
    if (isGatewayInternal(f)) return false;
    if (ALLOWLIST.has(f)) return false;
    return true;
  });
}

describe("gateway-only API consumption guard", () => {
  test("no non-allowlisted files reference direct runtime URLs (port 7821)", () => {
    const grepPattern = HARDCODED_PORT_PATTERNS.join("|");

    let grepOutput = "";
    try {
      grepOutput = execSync(
        `git grep -lE "${grepPattern}" -- '*.ts' '*.js' '*.swift' '*.md'`,
        { encoding: "utf-8", cwd: process.cwd() + "/.." },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — that's the happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const files = grepOutput.split("\n").filter((f) => f.length > 0);
    const violations = filterViolations(files);

    if (violations.length > 0) {
      const message = [
        "Found non-allowlisted files referencing direct runtime URLs (port 7821).",
        'All API requests must target gateway URLs — see AGENTS.md "Gateway-Only API Consumption".',
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "To fix: migrate the reference to use gateway URLs.",
        "If this is an intentional exception, add it to the ALLOWLIST in gateway-only-guard.test.ts.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  test("no non-allowlisted files construct URLs using RUNTIME_HTTP_PORT", () => {
    let grepOutput = "";
    try {
      grepOutput = execSync(
        `git grep -lE "${RUNTIME_PORT_URL_PATTERN}" -- '*.ts' '*.js' '*.swift' '*.md'`,
        { encoding: "utf-8", cwd: process.cwd() + "/.." },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — that's the happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const files = grepOutput.split("\n").filter((f) => f.length > 0);
    const violations = filterViolations(files);

    if (violations.length > 0) {
      const message = [
        "Found non-allowlisted files constructing URLs with RUNTIME_HTTP_PORT.",
        'All API requests must target gateway URLs — see AGENTS.md "Gateway-Only API Consumption".',
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "To fix: migrate the reference to use gateway URLs.",
        "If this is an intentional exception, add it to the ALLOWLIST in gateway-only-guard.test.ts.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  test("no non-allowlisted files construct localhost /v1 URLs with interpolated ports", () => {
    let grepOutput = "";
    try {
      grepOutput = execSync(
        `git grep -lE '${INTERPOLATED_LOCALHOST_V1_PATTERN}' -- '*.ts' '*.js' '*.swift' '*.md'`,
        { encoding: "utf-8", cwd: process.cwd() + "/.." },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — that's the happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const files = grepOutput.split("\n").filter((f) => f.length > 0);
    const violations = filterViolations(files);

    if (violations.length > 0) {
      const message = [
        "Found non-allowlisted files constructing localhost /v1 URLs with interpolated ports.",
        'All API requests must target gateway URLs — see AGENTS.md "Gateway-Only API Consumption".',
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "To fix: migrate the reference to use gateway URLs.",
        "If this is an intentional exception, add it to the ALLOWLIST in gateway-only-guard.test.ts.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});
