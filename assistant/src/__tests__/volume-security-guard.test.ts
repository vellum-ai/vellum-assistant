import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Guard test: assistant source code must not directly access files in the
 * `protected/` directory (`trust.json`, `keys.enc`, `store.key`,
 * `actor-token-signing-key`). In containerized (Docker) mode these files
 * live outside the assistant's data volume and are managed by the gateway.
 *
 * All access must go through the appropriate abstraction layer:
 *  - Trust rules: trust-store.ts / trust-client.ts (file vs gateway backend)
 *  - Credentials: encrypted-store.ts / ces-credential-client.ts
 *  - Signing keys: secure-keys.ts / credential-backend.ts
 *
 * Only the abstraction-layer files themselves (and tests) are allowed to
 * reference the raw file paths / helper functions.
 */

// ---------------------------------------------------------------------------
// Allowed files — abstraction layers that legitimately access protected/ files
// ---------------------------------------------------------------------------

const ALLOWED_FILES = new Set([
  // Trust store backends
  "assistant/src/permissions/trust-store.ts",
  "assistant/src/permissions/trust-client.ts",
  "assistant/src/permissions/trust-store-interface.ts",
  // Credential / encrypted store backends
  "assistant/src/security/encrypted-store.ts",
  "assistant/src/security/secure-keys.ts",
  "assistant/src/security/credential-backend.ts",
  "assistant/src/security/ces-credential-client.ts",
  // Token service owns the signing key lifecycle
  "assistant/src/runtime/auth/token-service.ts",
  // CLI commands that run outside Docker (trust management)
  "assistant/src/cli/commands/trust.ts",
  // Auth middleware documentation comment (not a file access)
  "assistant/src/runtime/auth/middleware.ts",
  // Permission checker: classifies file_read of signing key as High risk
  "assistant/src/permissions/checker.ts",
]);

// ---------------------------------------------------------------------------
// Patterns that indicate direct access to protected directory files
// ---------------------------------------------------------------------------

/**
 * Each entry is a `git grep -E` pattern and a human-readable description
 * for the error message.
 */
const GUARDED_PATTERNS: Array<{ pattern: string; description: string }> = [
  {
    pattern: "protected/trust\\.json",
    description: "direct reference to protected/trust.json",
  },
  {
    pattern: "protected/keys\\.enc",
    description: "direct reference to protected/keys.enc",
  },
  {
    pattern: "protected/store\\.key",
    description: "direct reference to protected/store.key",
  },
  {
    pattern: "actor-token-signing-key",
    description: "direct reference to actor-token-signing-key file",
  },
  {
    pattern: "\\bgetTrustPath\\b",
    description: "use of getTrustPath() (trust-store internal)",
  },
  {
    pattern: "\\bgetStoreKeyPath\\b",
    description: "use of getStoreKeyPath() (encrypted-store internal)",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("/__tests__/") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.js") ||
    filePath.endsWith(".spec.ts") ||
    filePath.endsWith(".spec.js")
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("volume security: protected directory access guard", () => {
  for (const { pattern, description } of GUARDED_PATTERNS) {
    test(`no ${description} outside allowed files`, () => {
      const repoRoot = getRepoRoot();

      let grepOutput = "";
      try {
        grepOutput = execFileSync(
          "git",
          [
            "grep",
            "-lE",
            pattern,
            "--",
            "assistant/src/**/*.ts",
            "assistant/src/*.ts",
          ],
          { encoding: "utf-8", cwd: repoRoot },
        ).trim();
      } catch (err) {
        // Exit code 1 means no matches — happy path
        if ((err as { status?: number }).status === 1) {
          return;
        }
        throw err;
      }

      const files = grepOutput.split("\n").filter((f) => f.length > 0);
      const violations = files.filter(
        (f) => !isTestFile(f) && !ALLOWED_FILES.has(f),
      );

      if (violations.length > 0) {
        const message = [
          `Found assistant source files with ${description}.`,
          "",
          "In containerized (Docker) mode, the protected/ directory is not",
          "accessible to the assistant. All access to protected files must go",
          "through the abstraction layers:",
          "  - Trust rules: trust-store.ts / trust-client.ts",
          "  - Credentials: encrypted-store.ts / ces-credential-client.ts",
          "  - Signing keys: secure-keys.ts / credential-backend.ts",
          "",
          "If this file is a new abstraction backend, add it to ALLOWED_FILES",
          "in this guard test. Otherwise, use the appropriate abstraction layer",
          "or gate the access behind !getIsContainerized().",
          "",
          "Violations:",
          ...violations.map((f) => `  - ${f}`),
        ].join("\n");

        expect(violations, message).toEqual([]);
      }
    });
  }
});
