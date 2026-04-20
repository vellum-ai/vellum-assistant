/**
 * Tests for gateway trust-store normalization behavior and matching parity
 * with the assistant trust-store logic.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, test, expect, beforeEach } from "bun:test";

import {
  loadRules,
  getAllRules,
  addRule,
  findMatchingRule,
  findHighestPriorityRule,
  clearRules,
  clearCache,
} from "../trust-store.js";

// GATEWAY_SECURITY_DIR is set by test-preload.ts — all trust.json reads/writes
// go to the per-file temp directory.

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

function readTrustFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(getTrustPath(), "utf-8"));
}

beforeEach(() => {
  clearCache();
  // Remove any leftover trust.json from previous test
  try {
    unlinkSync(getTrustPath());
  } catch {
    // file may not exist
  }
});

// ---------------------------------------------------------------------------
// Normalization on load
// ---------------------------------------------------------------------------

describe("normalization on load", () => {
  test("strips executionTarget and allowHighRisk on URL tool rules", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "r1",
          tool: "web_fetch",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
          executionTarget: "host",
          allowHighRisk: true,
        },
      ],
    });

    const rules = loadRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("r1");
    // URL rules should not have executionTarget or allowHighRisk.
    expect("executionTarget" in rules[0]).toBe(false);
    expect("allowHighRisk" in rules[0]).toBe(false);

    // Verify file was re-saved with normalized rules
    const saved = readTrustFile();
    expect(saved.version).toBe(3);
    const savedRules = saved.rules as Array<Record<string, unknown>>;
    expect(savedRules).toHaveLength(1);
    expect("executionTarget" in savedRules[0]).toBe(false);
    expect("allowHighRisk" in savedRules[0]).toBe(false);
  });

  test("strips executionTarget and allowHighRisk on managed skill rules", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "r2",
          tool: "scaffold_managed_skill",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
          executionTarget: "host",
          allowHighRisk: true,
        },
      ],
    });

    const rules = loadRules();
    expect(rules).toHaveLength(1);
    expect("executionTarget" in rules[0]).toBe(false);
    expect("allowHighRisk" in rules[0]).toBe(false);
  });

  test("strips executionTarget and allowHighRisk on skill_load rules", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "r3",
          tool: "skill_load",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
          executionTarget: "host",
          allowHighRisk: true,
        },
      ],
    });

    const rules = loadRules();
    expect(rules).toHaveLength(1);
    expect("executionTarget" in rules[0]).toBe(false);
    expect("allowHighRisk" in rules[0]).toBe(false);
  });

  test("preserves executionTarget but strips allowHighRisk on scoped tool rules", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "r4",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
          executionTarget: "host",
          allowHighRisk: true,
        },
      ],
    });

    const rules = loadRules();
    expect(rules).toHaveLength(1);
    expect((rules[0] as any).executionTarget).toBe("host");
    expect("allowHighRisk" in rules[0]).toBe(false);
  });

  test("preserves executionTarget but strips allowHighRisk on generic (unknown) tool rules", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "r5",
          tool: "future_tool",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
          executionTarget: "container",
          allowHighRisk: false,
        },
      ],
    });

    const rules = loadRules();
    expect(rules).toHaveLength(1);
    expect((rules[0] as any).executionTarget).toBe("container");
    expect("allowHighRisk" in rules[0]).toBe(false);
  });

  test("strips legacy principal-scoped fields and re-saves", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "r6",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
          principalKind: "user",
          principalId: "u-123",
          principalVersion: 1,
        },
      ],
    });

    const rules = loadRules();
    expect(rules).toHaveLength(1);
    const r = rules[0] as unknown as Record<string, unknown>;
    expect("principalKind" in r).toBe(false);
    expect("principalId" in r).toBe(false);
    expect("principalVersion" in r).toBe(false);
  });

  test("strips __internal: rules on load", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "r7-good",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
        {
          id: "r7-bad",
          tool: "__internal:debug",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
      ],
    });

    const rules = loadRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("r7-good");
  });

  test("does not re-save when no normalization is needed", () => {
    // Write a clean v3 file — loadRules should NOT re-save
    const data = {
      version: 3,
      rules: [
        {
          id: "r8",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
      ],
    };
    writeTrustFile(data);
    const originalContent = readFileSync(getTrustPath(), "utf-8");

    loadRules();

    // File content should not have changed (no re-save)
    const afterContent = readFileSync(getTrustPath(), "utf-8");
    expect(afterContent).toBe(originalContent);
  });
});

// ---------------------------------------------------------------------------
// Version handling
// ---------------------------------------------------------------------------

describe("version handling", () => {
  test("migrates v1 trust files to current version on re-save", () => {
    writeTrustFile({
      version: 1,
      rules: [
        {
          id: "v1-rule",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
      ],
    });

    const rules = loadRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("v1-rule");

    // File should have been re-saved with current version
    const saved = readTrustFile();
    expect(saved.version).toBe(3);
  });

  test("migrates v2 trust files to current version on re-save", () => {
    writeTrustFile({
      version: 2,
      rules: [
        {
          id: "v2-rule",
          tool: "file_read",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 90,
          createdAt: 1000,
        },
      ],
    });

    const rules = loadRules();
    expect(rules).toHaveLength(1);

    const saved = readTrustFile();
    expect(saved.version).toBe(3);
  });

  test("returns empty rules for unknown future versions", () => {
    writeTrustFile({
      version: 99,
      rules: [
        {
          id: "future-rule",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
      ],
    });

    const rules = loadRules();
    expect(rules).toHaveLength(0);

    // Original file should NOT be overwritten
    const saved = readTrustFile();
    expect(saved.version).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Scope matching
// ---------------------------------------------------------------------------

describe("scope matching", () => {
  test("'everywhere' scope matches any working directory", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "scope-1",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
      ],
    });

    const rules = loadRules();
    expect(rules).toHaveLength(1);

    expect(findMatchingRule("bash", "ls", "/any/path")).toBeTruthy();
    expect(findMatchingRule("bash", "ls", "/another/path")).toBeTruthy();
  });

  test("directory-scoped rule matches exact dir and subdirectories", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "scope-2",
          tool: "bash",
          pattern: "**",
          scope: "/home/user/project",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
      ],
    });

    loadRules();

    expect(findMatchingRule("bash", "ls", "/home/user/project")).toBeTruthy();
    expect(
      findMatchingRule("bash", "ls", "/home/user/project/sub"),
    ).toBeTruthy();
    expect(
      findMatchingRule("bash", "ls", "/home/user/project-evil"),
    ).toBeNull();
    expect(findMatchingRule("bash", "ls", "/home/user/other")).toBeNull();
  });

  test("rule without scope field defaults to everywhere", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "scope-3",
          tool: "bash",
          pattern: "**",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
      ],
    });

    loadRules();

    // Rule has no scope — parseTrustRule defaults it to "everywhere"
    expect(findMatchingRule("bash", "ls", "/any/path")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

describe("rule matching", () => {
  test("findMatchingRule matches by tool and pattern", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "match-1",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
        {
          id: "match-2",
          tool: "file_read",
          pattern: "/home/**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
      ],
    });

    loadRules();

    // ** matches any command for the bash tool
    expect(findMatchingRule("bash", "ls /tmp", "everywhere")).toBeTruthy();
    expect(findMatchingRule("bash", "rm -rf /", "everywhere")).toBeTruthy();
    // Wrong tool does not match
    expect(findMatchingRule("file_write", "ls /tmp", "everywhere")).toBeNull();
    // file_read pattern only matches /home/**
    expect(
      findMatchingRule("file_read", "/home/user/file.txt", "everywhere"),
    ).toBeTruthy();
    expect(
      findMatchingRule("file_read", "/etc/passwd", "everywhere"),
    ).toBeNull();
  });

  test("findHighestPriorityRule returns highest priority match across candidates", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "hp-1",
          tool: "bash",
          pattern: "ls **",
          scope: "everywhere",
          decision: "allow",
          priority: 50,
          createdAt: 1000,
        },
        {
          id: "hp-2",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "deny",
          priority: 100,
          createdAt: 1000,
        },
      ],
    });

    loadRules();

    const rule = findHighestPriorityRule("bash", ["ls /tmp"], "everywhere");
    expect(rule).toBeTruthy();
    expect(rule!.id).toBe("hp-2");
    expect(rule!.decision).toBe("deny");
  });

  test("deny wins ties at same priority", () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "tie-allow",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
        {
          id: "tie-deny",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "deny",
          priority: 100,
          createdAt: 2000,
        },
      ],
    });

    loadRules();

    const rule = findHighestPriorityRule("bash", ["anything"], "everywhere");
    expect(rule).toBeTruthy();
    expect(rule!.id).toBe("tie-deny");
  });
});

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

describe("CRUD operations", () => {
  test("addRule persists a new rule", () => {
    const rule = addRule("bash", "echo **", "everywhere", "allow", 80);
    expect(rule.id).toBeTruthy();
    expect(rule.tool).toBe("bash");
    expect(rule.pattern).toBe("echo **");
    expect(rule.decision).toBe("allow");
    expect(rule.priority).toBe(80);

    const all = getAllRules();
    expect(all.some((r) => r.id === rule.id)).toBe(true);
  });

  test("addRule rejects __internal: tools", () => {
    expect(() => addRule("__internal:debug", "**", "everywhere")).toThrow(
      "Cannot create internal pseudo-rule",
    );
  });

  test("clearRules empties the rule list", () => {
    addRule("bash", "**", "everywhere");
    expect(getAllRules().length).toBeGreaterThan(0);

    clearRules();
    expect(getAllRules()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Empty file / no file
// ---------------------------------------------------------------------------

describe("empty and missing files", () => {
  test("returns empty rules when trust file does not exist", () => {
    const rules = loadRules();
    expect(rules).toHaveLength(0);
  });

  test("handles empty rules array gracefully", () => {
    writeTrustFile({ version: 3, rules: [] });
    const rules = loadRules();
    expect(rules).toHaveLength(0);
  });

  test("handles malformed JSON gracefully", () => {
    const dir = getSecurityDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(getTrustPath(), "not json at all");

    const rules = loadRules();
    expect(rules).toHaveLength(0);
  });
});
