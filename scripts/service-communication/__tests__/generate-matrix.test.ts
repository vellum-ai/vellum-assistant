import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

import {
  MATRIX_ENTRIES,
  type MatrixEntry,
  type Protocol,
  type ServiceName,
} from "../matrix-source.js";
import { renderMatrix, serviceDisplayName } from "../generate-matrix.js";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const VALID_SERVICES: ServiceName[] = ["assistant", "gateway", "ces"];

const VALID_PROTOCOLS: Protocol[] = [
  "http",
  "websocket",
  "ipc-unix-ndjson",
  "stdio-ndjson",
  "unix-socket-ndjson",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function permutationKey(entry: MatrixEntry): string {
  return `${entry.caller}->${entry.callee}:${entry.protocol}:${entry.label}`;
}

/**
 * Check whether a glob pattern matches at least one file in the repo.
 * Uses Bun's Glob API for fast native matching.
 */
function globMatchesFiles(pattern: string): boolean {
  const glob = new Glob(pattern);
  for (const _match of glob.scanSync({ cwd: REPO_ROOT })) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("service communication matrix", () => {
  test("matrix is not empty", () => {
    expect(MATRIX_ENTRIES.length).toBeGreaterThan(0);
  });

  test("every entry has a non-empty label", () => {
    for (const entry of MATRIX_ENTRIES) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
    }
  });

  test("every entry uses a valid service name for caller and callee", () => {
    for (const entry of MATRIX_ENTRIES) {
      expect(VALID_SERVICES).toContain(entry.caller);
      expect(VALID_SERVICES).toContain(entry.callee);
    }
  });

  test("caller and callee are different services", () => {
    for (const entry of MATRIX_ENTRIES) {
      expect(entry.caller).not.toBe(entry.callee);
    }
  });

  test("every entry uses a valid protocol", () => {
    for (const entry of MATRIX_ENTRIES) {
      expect(VALID_PROTOCOLS).toContain(entry.protocol);
    }
  });

  test("every entry has a non-empty auth field", () => {
    for (const entry of MATRIX_ENTRIES) {
      expect(entry.auth.trim().length).toBeGreaterThan(0);
    }
  });

  test("every entry has a non-empty description", () => {
    for (const entry of MATRIX_ENTRIES) {
      expect(entry.description.trim().length).toBeGreaterThan(0);
    }
  });

  test("every entry has at least one caller glob", () => {
    for (const entry of MATRIX_ENTRIES) {
      expect(entry.callerGlobs.length).toBeGreaterThan(0);
    }
  });

  test("every entry has at least one callee glob", () => {
    for (const entry of MATRIX_ENTRIES) {
      expect(entry.calleeGlobs.length).toBeGreaterThan(0);
    }
  });

  test("no duplicate permutation keys", () => {
    const keys = MATRIX_ENTRIES.map(permutationKey);
    const seen = new Set<string>();
    for (const key of keys) {
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test("caller globs reference existing files", () => {
    const missing: string[] = [];
    for (const entry of MATRIX_ENTRIES) {
      for (const pattern of entry.callerGlobs) {
        if (!globMatchesFiles(pattern)) {
          missing.push(`[${entry.label}] caller: ${pattern}`);
        }
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Matrix entries reference missing caller files:\n${missing.join("\n")}`,
      );
    }
  });

  test("callee globs reference existing files", () => {
    const missing: string[] = [];
    for (const entry of MATRIX_ENTRIES) {
      for (const pattern of entry.calleeGlobs) {
        if (!globMatchesFiles(pattern)) {
          missing.push(`[${entry.label}] callee: ${pattern}`);
        }
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Matrix entries reference missing callee files:\n${missing.join("\n")}`,
      );
    }
  });

  test("renderMatrix produces valid markdown", () => {
    const output = renderMatrix(MATRIX_ENTRIES);
    expect(output).toContain("# Service Communication Matrix");
    expect(output).toContain("## Summary");
    // Verify the summary table has a row for every entry
    for (const entry of MATRIX_ENTRIES) {
      expect(output).toContain(entry.label);
    }
  });

  test("renderMatrix includes detail sections for every direction", () => {
    const output = renderMatrix(MATRIX_ENTRIES);
    const directions = new Set(
      MATRIX_ENTRIES.map(
        (e) =>
          `## ${serviceDisplayName(e.caller)} -> ${serviceDisplayName(e.callee)}`,
      ),
    );
    for (const heading of directions) {
      expect(output).toContain(heading);
    }
  });

  test("all gateway route files that proxy to assistant are covered by a matrix callerGlob", async () => {
    /**
     * Patterns that identify a gateway route file as an assistant-upstream
     * callsite. Any non-test .ts file in gateway/src/http/routes/ that
     * contains one of these strings must appear in at least one callerGlob
     * of a gateway->assistant matrix entry.
     */
    const PROXY_PATTERNS = [
      "assistantRuntimeBaseUrl",
      "proxyForward",
      "proxyForwardToResponse",
      "buildWsUpstreamUrl",
    ];

    /**
     * Files in gateway/src/http/routes/ that reference assistant upstream
     * patterns for reasons other than proxying (e.g., they are gateway-native
     * endpoints that share utility helpers or type imports). Excluded from the
     * coverage assertion with an explanation.
     *
     * Add to this list — with a comment — whenever a new file legitimately
     * matches the proxy patterns but is NOT a callsite.
     */
    const ALLOWLIST = new Set<string>([
      // Reads/writes config.json locally; never proxies to assistant.
      "gateway/src/http/routes/privacy-config.ts",
    ]);

    // Collect all callerGlobs from gateway->assistant entries.
    const gatewayToAssistantEntries = MATRIX_ENTRIES.filter(
      (e) => e.caller === "gateway" && e.callee === "assistant",
    );
    const coveredFiles = new Set<string>();
    for (const entry of gatewayToAssistantEntries) {
      for (const pattern of entry.callerGlobs) {
        const glob = new Glob(pattern);
        for (const match of glob.scanSync({ cwd: REPO_ROOT })) {
          coveredFiles.add(match);
        }
      }
    }

    // Scan all non-test .ts files in gateway/src/http/routes/ for proxy patterns.
    const routeGlob = new Glob("gateway/src/http/routes/*.ts");
    const uncovered: string[] = [];

    for (const relPath of routeGlob.scanSync({ cwd: REPO_ROOT })) {
      // Skip test files — they import proxy helpers for mocking, not for calling assistant.
      if (relPath.endsWith(".test.ts")) continue;

      const fullPath = join(REPO_ROOT, relPath);
      const content = await Bun.file(fullPath).text();
      const isCallsite = PROXY_PATTERNS.some((p) => content.includes(p));

      if (!isCallsite) continue;
      if (ALLOWLIST.has(relPath)) continue;

      if (!coveredFiles.has(relPath)) {
        uncovered.push(relPath);
      }
    }

    if (uncovered.length > 0) {
      throw new Error(
        [
          "The following gateway route files proxy to assistant but have no matrix entry:",
          ...uncovered.map((f) => `  ${f}`),
          "",
          "Add a Gateway -> Assistant entry in matrix-source.ts with a callerGlob",
          "that matches each file, or add it to ALLOWLIST if it is not a true callsite.",
        ].join("\n"),
      );
    }
  });
});
