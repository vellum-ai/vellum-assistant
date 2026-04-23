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
});
