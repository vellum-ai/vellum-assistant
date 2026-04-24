/**
 * Guard test: enforce import discipline for @vellumai/service-contracts.
 *
 * Rules enforced:
 *
 * 1. No new imports of `@vellumai/ces-contracts` outside the
 *    `packages/ces-contracts` shim. The shim re-exports everything from
 *    `@vellumai/service-contracts` for backwards compatibility; all other
 *    code must import from `@vellumai/service-contracts` directly.
 *
 * 2. `assistant/`, `gateway/`, and `credential-executor/` source files must
 *    not import the aggregate root `@vellumai/service-contracts` (i.e.
 *    `from "@vellumai/service-contracts"`). They must use explicit domain
 *    subpaths (e.g. `@vellumai/service-contracts/credential-rpc`).
 *    The aggregate root is an internal barrel consumed only by the
 *    `packages/ces-contracts` shim.
 *
 * See ARCHITECTURE.md (Credential Execution Service section) and
 * assistant/docs/credential-execution-service.md (Shared Private Packages)
 * for the rationale.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/** Resolve the repo root from the assistant test directory. */
function getRepoRoot(): string {
  return join(import.meta.dir, "..", "..", "..");
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

/**
 * Paths that are permitted to reference `@vellumai/ces-contracts`.
 * Only the ces-contracts shim package itself is allowed.
 */
const CES_CONTRACTS_ALLOWLIST = new Set([
  // The compatibility shim is the only file allowed to import from ces-contracts
  // (it re-exports to ces-contracts consumers).
  "packages/ces-contracts/src/index.ts",
  "packages/ces-contracts/src/credential-rpc.ts",
  "packages/ces-contracts/src/error.ts",
  "packages/ces-contracts/src/grants.ts",
  "packages/ces-contracts/src/handles.ts",
  "packages/ces-contracts/src/rendering.ts",
  "packages/ces-contracts/src/rpc.ts",
  "packages/ces-contracts/src/trust-rules.ts",
]);

/**
 * Paths that are permitted to import the aggregate root
 * `@vellumai/service-contracts` (without a subpath).
 * Only the ces-contracts shim is allowed; all runtime code must use subpaths.
 */
const AGGREGATE_ROOT_ALLOWLIST = new Set([
  // The ces-contracts shim re-exports the aggregate root by design.
  "packages/ces-contracts/src/index.ts",
]);

describe("service-contracts import discipline", () => {
  // ---------------------------------------------------------------------------
  // Rule 1: No @vellumai/ces-contracts outside the shim
  // ---------------------------------------------------------------------------

  test("no @vellumai/ces-contracts imports outside packages/ces-contracts shim", () => {
    const repoRoot = getRepoRoot();

    let grepOutput = "";
    try {
      grepOutput = execFileSync(
        "git",
        [
          "grep",
          "-lE",
          '@vellumai/ces-contracts',
          "--",
          "assistant/**/*.ts",
          "gateway/**/*.ts",
          "credential-executor/**/*.ts",
          "packages/assistant-client/**/*.ts",
          "packages/ces-client/**/*.ts",
          "packages/gateway-client/**/*.ts",
          "packages/credential-storage/**/*.ts",
          "packages/egress-proxy/**/*.ts",
          "packages/service-contracts/**/*.ts",
          "cli/**/*.ts",
          "skills/**/*.ts",
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
    const violations = files.filter((f) => {
      if (isTestFile(f)) return false;
      if (CES_CONTRACTS_ALLOWLIST.has(f)) return false;
      return true;
    });

    if (violations.length > 0) {
      const message = [
        "Found files importing @vellumai/ces-contracts outside the packages/ces-contracts shim.",
        "",
        "The @vellumai/ces-contracts package is a backwards-compatibility shim.",
        "New code must import from @vellumai/service-contracts using explicit subpaths:",
        "  @vellumai/service-contracts/credential-rpc",
        "  @vellumai/service-contracts/trust-rules",
        "  @vellumai/service-contracts/handles",
        "  @vellumai/service-contracts/grants",
        "  @vellumai/service-contracts/rpc",
        "  @vellumai/service-contracts/rendering",
        "  @vellumai/service-contracts/error",
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "To fix: replace @vellumai/ces-contracts with the appropriate",
        "@vellumai/service-contracts/<subpath> import.",
        "If this is an intentional exception, add it to CES_CONTRACTS_ALLOWLIST",
        "in service-contracts-import-guard.test.ts.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  // ---------------------------------------------------------------------------
  // Rule 2: No aggregate-root @vellumai/service-contracts in runtime directories
  // ---------------------------------------------------------------------------

  test("assistant/gateway/credential-executor use explicit service-contracts subpaths (no aggregate root)", () => {
    const repoRoot = getRepoRoot();

    // Match the aggregate root import: from "@vellumai/service-contracts" (with closing quote, no slash after)
    // This catches both single and double quote forms.
    const aggregateRootPattern =
      "from ['\"]@vellumai/service-contracts['\"]";

    let grepOutput = "";
    try {
      grepOutput = execFileSync(
        "git",
        [
          "grep",
          "-lE",
          aggregateRootPattern,
          "--",
          "assistant/**/*.ts",
          "gateway/**/*.ts",
          "credential-executor/**/*.ts",
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
    const violations = files.filter((f) => {
      if (isTestFile(f)) return false;
      if (AGGREGATE_ROOT_ALLOWLIST.has(f)) return false;
      return true;
    });

    if (violations.length > 0) {
      const message = [
        "Found files importing the aggregate root @vellumai/service-contracts.",
        "",
        "assistant/, gateway/, and credential-executor/ must import service-contracts",
        "using explicit domain subpaths, not the aggregate root barrel:",
        "  @vellumai/service-contracts/credential-rpc",
        "  @vellumai/service-contracts/trust-rules",
        "  @vellumai/service-contracts/handles",
        "  @vellumai/service-contracts/grants",
        "  @vellumai/service-contracts/rpc",
        "  @vellumai/service-contracts/rendering",
        "  @vellumai/service-contracts/error",
        "",
        "The aggregate root is reserved for the packages/ces-contracts shim.",
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "To fix: replace `from \"@vellumai/service-contracts\"` with the",
        "appropriate `from \"@vellumai/service-contracts/<subpath>\"` import.",
        "If this is an intentional exception, add it to AGGREGATE_ROOT_ALLOWLIST",
        "in service-contracts-import-guard.test.ts.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});
