/**
 * Tests for the gateway IPC trust-rule handlers — verifies that the
 * `match_trust_rule` handler forwards the optional `resolvedPaths`
 * parameter to the underlying trust-store matching functions.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { clearCache } from "../trust-store.js";
import { trustRuleRoutes } from "./trust-rule-handlers.js";

function getSecurityDir(): string {
  return process.env.GATEWAY_SECURITY_DIR!;
}

function getTrustPath(): string {
  return join(getSecurityDir(), "trust.json");
}

function writeTrustFile(data: Record<string, unknown>): void {
  const dir = getSecurityDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getTrustPath(), JSON.stringify(data));
}

const matchRuleHandler = trustRuleRoutes.find(
  (r) => r.method === "match_trust_rule",
)!.handler;

beforeEach(() => {
  clearCache();
  try {
    unlinkSync(getTrustPath());
  } catch {
    // file may not exist
  }
});

describe("match_trust_rule IPC handler — resolvedPaths", () => {
  test("matches when all resolvedPaths are covered by rule scope", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "ipc-rp-in",
          tool: "file_write",
          pattern: "**",
          scope: "/ws/scratch/*",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
      ],
    });

    const result = matchRuleHandler({
      tool: "file_write",
      scope: "/unrelated/cwd",
      commands: ["/ws/scratch/a"],
      resolvedPaths: ["/ws/scratch/a", "/ws/scratch/b"],
    }) as { rule: { id: string } | null };

    expect(result.rule).toBeTruthy();
    expect(result.rule!.id).toBe("ipc-rp-in");
  });

  test("does not match when a resolvedPath is outside rule scope", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "ipc-rp-out",
          tool: "file_write",
          pattern: "**",
          scope: "/ws/scratch/*",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
      ],
    });

    const result = matchRuleHandler({
      tool: "file_write",
      scope: "/ws/scratch/a",
      commands: ["/ws/scratch/a"],
      resolvedPaths: ["/ws/scratch/a", "/ws/other/b"],
    }) as { rule: unknown };

    expect(result.rule).toBeNull();
  });

  test("single-pattern match also forwards resolvedPaths", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "ipc-rp-single",
          tool: "file_write",
          pattern: "**",
          scope: "/ws/scratch/*",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
      ],
    });

    const matches = matchRuleHandler({
      tool: "file_write",
      scope: "/unrelated/cwd",
      pattern: "/ws/scratch/a",
      resolvedPaths: ["/ws/scratch/a"],
    }) as { rule: { id: string } | null };
    expect(matches.rule).toBeTruthy();
    expect(matches.rule!.id).toBe("ipc-rp-single");

    const rejects = matchRuleHandler({
      tool: "file_write",
      scope: "/unrelated/cwd",
      pattern: "/ws/scratch/a",
      resolvedPaths: ["/ws/other/a"],
    }) as { rule: unknown };
    expect(rejects.rule).toBeNull();
  });
});
