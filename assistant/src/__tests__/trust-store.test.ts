import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Create a temp directory for the trust file
const testDir = mkdtempSync(join(tmpdir(), "trust-store-test-"));

// Mock platform module so trust-store writes to temp dir instead of ~/.vellum
mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

// Mock logger to suppress output during tests
mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

import { getDefaultRuleTemplates } from "../permissions/defaults.js";
import {
  addRule,
  clearAllRules,
  clearCache,
  findDenyRule,
  findHighestPriorityRule,
  findMatchingRule,
  getAllRules,
  removeRule,
  updateRule,
} from "../permissions/trust-store.js";

const trustPath = join(testDir, "protected", "trust.json");
const legacyTrustPath = join(testDir, "trust.json");
const DEFAULT_TEMPLATES = getDefaultRuleTemplates();
const NUM_DEFAULTS = DEFAULT_TEMPLATES.length;
const DEFAULT_PRIORITY_BY_ID = new Map(
  DEFAULT_TEMPLATES.map((t) => [t.id, t.priority]),
);

describe("Trust Store", () => {
  beforeEach(() => {
    // Clear cached rules and remove the trust file between tests
    clearCache();
    try {
      rmSync(trustPath);
    } catch {
      /* may not exist */
    }
    try {
      rmSync(legacyTrustPath);
    } catch {
      /* may not exist */
    }
  });

  // Intentionally do not remove `testDir` in afterAll.
  // A late async log flush can still attempt to open `test.log` under this dir,
  // which intermittently causes an unhandled ENOENT in CI if the dir is removed.
  // ── addRule ─────────────────────────────────────────────────────

  describe("addRule", () => {
    test("adds a rule and returns it", () => {
      const rule = addRule("bash", "git *", "/home/user/project");
      expect(rule.id).toBeDefined();
      expect(rule.tool).toBe("bash");
      expect(rule.pattern).toBe("git *");
      expect(rule.scope).toBe("/home/user/project");
      expect(rule.decision).toBe("allow");
      expect(rule.priority).toBe(100);
      expect(rule.createdAt).toBeGreaterThan(0);
    });

    test("assigns unique IDs to each rule", () => {
      const rule1 = addRule("bash", "npm *", "/tmp");
      const rule2 = addRule("bash", "bun *", "/tmp");
      expect(rule1.id).not.toBe(rule2.id);
    });

    test("persists rule to disk", () => {
      addRule("bash", "git push", "/home/user");
      const raw = readFileSync(trustPath, "utf-8");
      const data = JSON.parse(raw);
      expect(data.version).toBe(3);
      expect(data.rules).toHaveLength(1 + NUM_DEFAULTS);
      const userRule = data.rules.find(
        (r: { pattern: string }) => r.pattern === "git push",
      );
      expect(userRule).toBeDefined();
      expect(userRule.priority).toBe(100);
    });

    test("multiple rules accumulate", () => {
      addRule("bash", "git *", "/tmp");
      addRule("file_write", "/tmp/*", "/tmp");
      addRule("bash", "npm *", "/tmp");
      expect(getAllRules()).toHaveLength(3 + NUM_DEFAULTS);
    });

    test("default priority is 100", () => {
      const rule = addRule("bash", "git *", "/tmp");
      expect(rule.priority).toBe(100);
    });

    test("custom priority is respected", () => {
      const rule = addRule("bash", "git *", "/tmp", "allow", 5);
      expect(rule.priority).toBe(5);
    });

    test("rules are sorted by priority descending in getAllRules", () => {
      addRule("bash", "low *", "/tmp", "allow", 0);
      addRule("bash", "high *", "/tmp", "allow", 2);
      addRule("bash", "med *", "/tmp", "allow", 1);
      const rules = getAllRules();
      // Default ask rules have higher priority than user rules
      const maxDefaultPriority = Math.max(
        ...DEFAULT_TEMPLATES.map((t) => t.priority),
      );
      expect(rules[0].priority).toBe(maxDefaultPriority);
      const userRules = rules.filter((r) => !r.id.startsWith("default:"));
      expect(userRules[0].priority).toBe(2);
      expect(userRules[1].priority).toBe(1);
      expect(userRules[2].priority).toBe(0);
    });

    test("accepts allowHighRisk option and persists it", () => {
      const rule = addRule("bash", "sudo *", "everywhere", "allow", 100, {
        allowHighRisk: true,
      });
      expect(rule.allowHighRisk).toBe(true);
      // Verify it persists to disk
      clearCache();
      const rules = getAllRules();
      const found = rules.find((r) => r.id === rule.id);
      expect(found).toBeDefined();
      expect(found!.allowHighRisk).toBe(true);
    });

    test("addRule without allowHighRisk option does not set the field", () => {
      const rule = addRule("bash", "git *", "/tmp");
      expect(rule.allowHighRisk).toBeUndefined();
      // Verify on disk
      const raw = JSON.parse(readFileSync(trustPath, "utf-8"));
      const diskRule = raw.rules.find((r: { id: string }) => r.id === rule.id);
      expect(diskRule).toBeDefined();
      expect(diskRule).not.toHaveProperty("allowHighRisk");
    });

    test("at same priority deny rules sort before allow rules", () => {
      addRule("bash", "allow *", "/tmp", "allow", 100);
      addRule("bash", "deny *", "/tmp", "deny", 100);
      const userRules = getAllRules().filter(
        (r) => !r.id.startsWith("default:"),
      );
      expect(userRules[0].decision).toBe("deny");
      expect(userRules[1].decision).toBe("allow");
    });

    test("accepts executionTarget option and persists it", () => {
      const rule = addRule("skill_tool", "skill_tool:*", "/tmp", "allow", 100, {
        executionTarget: "sandbox",
      });
      expect(rule.executionTarget).toBe("sandbox");

      // Verify persistence to disk
      clearCache();
      const rules = getAllRules();
      const found = rules.find((r) => r.id === rule.id);
      expect(found).toBeDefined();
      expect(found!.executionTarget).toBe("sandbox");
    });

    test("accepts all contextual options together (target, allowHighRisk)", () => {
      const rule = addRule(
        "risky_tool",
        "risky_tool:*",
        "everywhere",
        "allow",
        100,
        {
          allowHighRisk: true,
          executionTarget: "host",
        },
      );
      expect(rule.allowHighRisk).toBe(true);
      expect(rule.executionTarget).toBe("host");

      // Verify on disk
      const raw = JSON.parse(readFileSync(trustPath, "utf-8"));
      const diskRule = raw.rules.find((r: { id: string }) => r.id === rule.id);
      expect(diskRule).toBeDefined();
      expect(diskRule.allowHighRisk).toBe(true);
      expect(diskRule.executionTarget).toBe("host");
    });

    test("addRule without options does not set optional fields", () => {
      const rule = addRule("bash", "echo *", "/tmp");
      expect(rule.executionTarget).toBeUndefined();

      // Verify on disk
      const raw = JSON.parse(readFileSync(trustPath, "utf-8"));
      const diskRule = raw.rules.find((r: { id: string }) => r.id === rule.id);
      expect(diskRule).toBeDefined();
      expect(diskRule).not.toHaveProperty("executionTarget");
    });
  });

  // ── removeRule ──────────────────────────────────────────────────

  describe("removeRule", () => {
    test("removes an existing rule", () => {
      const rule = addRule("bash", "git *", "/tmp");
      expect(removeRule(rule.id)).toBe(true);
      expect(getAllRules()).toHaveLength(NUM_DEFAULTS);
    });

    test("returns false for non-existent ID", () => {
      expect(removeRule("non-existent-id")).toBe(false);
    });

    test("persists removal to disk", () => {
      const rule = addRule("bash", "npm *", "/tmp");
      removeRule(rule.id);
      // Reload from disk to verify
      clearCache();
      expect(getAllRules()).toHaveLength(NUM_DEFAULTS);
    });

    test("only removes the targeted rule", () => {
      const rule1 = addRule("bash", "git *", "/tmp");
      const rule2 = addRule("bash", "npm *", "/tmp");
      removeRule(rule1.id);
      const remaining = getAllRules();
      expect(remaining).toHaveLength(1 + NUM_DEFAULTS);
      expect(remaining.find((r) => r.id === rule2.id)).toBeDefined();
    });
  });

  // ── updateRule ─────────────────────────────────────────────────

  describe("updateRule", () => {
    test("updates pattern on an existing rule", () => {
      const rule = addRule("bash", "git *", "/tmp");
      const updated = updateRule(rule.id, { pattern: "git push *" });
      expect(updated.pattern).toBe("git push *");
      expect(updated.id).toBe(rule.id);
      expect(updated.tool).toBe("bash");
    });

    test("updates multiple fields at once", () => {
      const rule = addRule("bash", "npm *", "/tmp");
      const updated = updateRule(rule.id, {
        tool: "file_write",
        scope: "/home",
        decision: "deny",
        priority: 50,
      });
      expect(updated.tool).toBe("file_write");
      expect(updated.scope).toBe("/home");
      expect(updated.decision).toBe("deny");
      expect(updated.priority).toBe(50);
    });

    test("throws for non-existent rule ID", () => {
      expect(() => updateRule("non-existent-id", { pattern: "test" })).toThrow(
        "Trust rule not found: non-existent-id",
      );
    });

    test("persists update to disk", () => {
      const rule = addRule("bash", "git *", "/tmp");
      updateRule(rule.id, { pattern: "git status" });
      clearCache();
      const rules = getAllRules();
      const found = rules.find((r) => r.id === rule.id);
      expect(found).toBeDefined();
      expect(found!.pattern).toBe("git status");
    });

    test("re-sorts rules after priority change", () => {
      const rule1 = addRule("bash", "low *", "/tmp", "allow", 10);
      const rule2 = addRule("bash", "high *", "/tmp", "allow", 200);
      // rule2 should be first (higher priority)
      let userRules = getAllRules().filter((r) => !r.id.startsWith("default:"));
      expect(userRules[0].id).toBe(rule2.id);
      // Update rule1 to have higher priority
      updateRule(rule1.id, { priority: 300 });
      userRules = getAllRules().filter((r) => !r.id.startsWith("default:"));
      expect(userRules[0].id).toBe(rule1.id);
    });

    test("leaves unchanged fields intact", () => {
      const rule = addRule("bash", "git *", "/home/user", "allow", 100);
      updateRule(rule.id, { pattern: "git push *" });
      const updated = getAllRules().find((r) => r.id === rule.id)!;
      expect(updated.tool).toBe("bash");
      expect(updated.scope).toBe("/home/user");
      expect(updated.decision).toBe("allow");
      expect(updated.priority).toBe(100);
      expect(updated.createdAt).toBe(rule.createdAt);
    });
  });

  // ── findMatchingRule ────────────────────────────────────────────

  describe("findMatchingRule", () => {
    test("finds exact match", () => {
      addRule("bash", "git push", "/tmp");
      const match = findMatchingRule("bash", "git push", "/tmp");
      expect(match).not.toBeNull();
      expect(match!.pattern).toBe("git push");
    });

    test("finds glob wildcard match", () => {
      addRule("bash", "git *", "/tmp");
      const match = findMatchingRule("bash", "git push origin main", "/tmp");
      expect(match).not.toBeNull();
    });

    test("returns null when tool does not match", () => {
      addRule("file_write", "file_write:/tmp/*", "/tmp");
      // host_file_read default is 'ask' so findMatchingRule (allow-only) won't find it
      const match = findMatchingRule(
        "host_file_read",
        "host_file_read:/etc/hosts",
        "/tmp",
      );
      expect(match).toBeNull();
    });

    test("returns null when pattern does not match", () => {
      addRule("host_file_read", "host_file_read:/etc/hosts", "/tmp");
      const match = findMatchingRule(
        "host_file_read",
        "host_file_read:/var/log/syslog",
        "/tmp",
      );
      expect(match).toBeNull();
    });

    // Scope matching
    describe("scope matching", () => {
      test("matches when scope equals rule scope", () => {
        addRule("bash", "npm *", "/home/user/project");
        const match = findMatchingRule(
          "bash",
          "npm install",
          "/home/user/project",
        );
        expect(match).not.toBeNull();
      });

      test("matches when scope is under rule scope (prefix)", () => {
        addRule("bash", "npm *", "/home/user");
        const match = findMatchingRule(
          "bash",
          "npm install",
          "/home/user/project/sub",
        );
        expect(match).not.toBeNull();
      });

      test("does not match when scope is outside rule scope", () => {
        addRule(
          "host_file_read",
          "host_file_read:/home/user/project/*",
          "/home/user/project",
        );
        const match = findMatchingRule(
          "host_file_read",
          "host_file_read:/home/user/project/file.txt",
          "/home/other",
        );
        expect(match).toBeNull();
      });

      test("everywhere scope matches any directory", () => {
        addRule("bash", "git *", "everywhere");
        const match = findMatchingRule(
          "bash",
          "git status",
          "/any/random/path",
        );
        expect(match).not.toBeNull();
      });

      test("everywhere scope matches root", () => {
        addRule("bash", "ls", "everywhere");
        const match = findMatchingRule("bash", "ls", "/");
        expect(match).not.toBeNull();
      });

      test("does not match sibling path with shared prefix", () => {
        addRule(
          "host_file_read",
          "host_file_read:/home/user/project/*",
          "/home/user/project",
        );
        const match = findMatchingRule(
          "host_file_read",
          "host_file_read:/home/user/project/file.txt",
          "/home/user/project-evil",
        );
        expect(match).toBeNull();
      });

      test("matches exact scope with trailing slash on working dir", () => {
        addRule("bash", "npm *", "/home/user/project");
        const match = findMatchingRule(
          "bash",
          "npm install",
          "/home/user/project/",
        );
        expect(match).not.toBeNull();
      });

      test("matches when rule scope has trailing slash", () => {
        addRule("bash", "npm *", "/home/user/project/");
        const match = findMatchingRule(
          "bash",
          "npm install",
          "/home/user/project",
        );
        expect(match).not.toBeNull();
      });

      test("does not match sibling with glob-suffixed scope", () => {
        addRule(
          "host_file_read",
          "host_file_read:/home/user/project/*",
          "/home/user/project*",
        );
        const match = findMatchingRule(
          "host_file_read",
          "host_file_read:/home/user/project/file.txt",
          "/home/user/project-evil",
        );
        expect(match).toBeNull();
      });
    });

    // Pattern matching with minimatch
    describe("pattern matching", () => {
      test("matches * wildcard", () => {
        addRule("bash", "npm *", "/tmp");
        expect(findMatchingRule("bash", "npm install", "/tmp")).not.toBeNull();
        expect(findMatchingRule("bash", "npm test", "/tmp")).not.toBeNull();
      });

      test("matches exact string", () => {
        addRule("host_file_read", "host_file_read:/etc/hosts", "/tmp");
        expect(
          findMatchingRule(
            "host_file_read",
            "host_file_read:/etc/hosts",
            "/tmp",
          ),
        ).not.toBeNull();
        expect(
          findMatchingRule(
            "host_file_read",
            "host_file_read:/etc/passwd",
            "/tmp",
          ),
        ).toBeNull();
      });

      test("matches file path pattern", () => {
        addRule("file_write", "/tmp/*", "/tmp");
        expect(
          findMatchingRule("file_write", "/tmp/file.txt", "/tmp"),
        ).not.toBeNull();
      });

      test("star pattern matches single-segment strings", () => {
        addRule("file_write", "*", "/tmp");
        // minimatch '*' matches strings without path separators
        expect(
          findMatchingRule("file_write", "file.txt", "/tmp"),
        ).not.toBeNull();
      });

      test("star pattern does not match paths with slashes", () => {
        addRule("file_write", "*", "/tmp");
        // minimatch '*' does not cross '/' boundaries
        expect(
          findMatchingRule("file_write", "/any/path/file.txt", "/tmp"),
        ).toBeNull();
      });
    });
  });

  // ── findHighestPriorityRule ──────────────────────────────────────

  describe("findHighestPriorityRule", () => {
    test("returns highest priority matching rule", () => {
      addRule("bash", "rm *", "/tmp", "allow", 0);
      addRule("bash", "rm *", "/tmp", "deny", 100);
      const match = findHighestPriorityRule("bash", ["rm file.txt"], "/tmp");
      expect(match).not.toBeNull();
      expect(match!.decision).toBe("deny");
      expect(match!.priority).toBe(100);
    });

    test("higher priority allow beats lower priority deny", () => {
      addRule("bash", "rm *", "/tmp", "deny", 0);
      addRule("bash", "rm *", "/tmp", "allow", 100);
      const match = findHighestPriorityRule("bash", ["rm file.txt"], "/tmp");
      expect(match).not.toBeNull();
      expect(match!.decision).toBe("allow");
    });

    test("same priority: deny beats allow", () => {
      addRule("bash", "rm *", "/tmp", "allow", 100);
      addRule("bash", "rm *", "/tmp", "deny", 100);
      const match = findHighestPriorityRule("bash", ["rm file.txt"], "/tmp");
      expect(match).not.toBeNull();
      expect(match!.decision).toBe("deny");
    });

    test("checks multiple command candidates", () => {
      addRule("web_fetch", "web_fetch:https://example.com/*", "/tmp", "allow");
      const match = findHighestPriorityRule(
        "web_fetch",
        [
          "web_fetch:https://example.com/page",
          "web_fetch:https://example.com/*",
        ],
        "/tmp",
      );
      expect(match).not.toBeNull();
    });

    test("returns null when no rule matches", () => {
      // Use file_read with a non-workspace path — file_read defaults only
      // cover specific workspace files, so /tmp paths won't match any default.
      addRule("file_read", "file_read:/specific/*", "/tmp", "allow");
      const match = findHighestPriorityRule(
        "file_read",
        ["file_read:/other/path"],
        "/tmp",
      );
      expect(match).toBeNull();
    });

    test("respects scope matching", () => {
      // Use file_read — bash has a global default allow rule that matches everywhere.
      addRule(
        "file_read",
        "file_read:/home/user/project/*",
        "/home/user/project",
        "deny",
      );
      expect(
        findHighestPriorityRule(
          "file_read",
          ["file_read:/home/user/project/file.txt"],
          "/home/user/project/sub",
        ),
      ).not.toBeNull();
      expect(
        findHighestPriorityRule(
          "file_read",
          ["file_read:/home/user/project/file.txt"],
          "/home/other",
        ),
      ).toBeNull();
    });

    test("everywhere scope matches any directory", () => {
      addRule("bash", "git *", "everywhere", "allow");
      const match = findHighestPriorityRule(
        "bash",
        ["git status"],
        "/any/random/path",
      );
      expect(match).not.toBeNull();
    });
  });

  // ── getAllRules ─────────────────────────────────────────────────

  describe("getAllRules", () => {
    test("returns default rules when no user rules exist", () => {
      const rules = getAllRules();
      expect(rules).toHaveLength(NUM_DEFAULTS);
      expect(rules.every((r) => r.id.startsWith("default:"))).toBe(true);
    });

    test("returns a copy (not the internal array)", () => {
      addRule("bash", "git *", "/tmp");
      const rules1 = getAllRules();
      const rules2 = getAllRules();
      expect(rules1).toEqual(rules2);
      expect(rules1).not.toBe(rules2); // different references
    });
  });

  // ── clearCache ─────────────────────────────────────────────────

  describe("clearCache", () => {
    test("forces reload from disk on next access", () => {
      addRule("bash", "git *", "/tmp");
      expect(getAllRules()).toHaveLength(1 + NUM_DEFAULTS);
      clearCache();
      // After clearing cache, rules are reloaded from disk
      expect(getAllRules()).toHaveLength(1 + NUM_DEFAULTS);
    });
  });

  // ── persistence ─────────────────────────────────────────────────

  describe("persistence", () => {
    test("rules survive cache clear (loaded from disk)", () => {
      const rule = addRule("bash", "npm *", "/tmp");
      clearCache();
      const rules = getAllRules();
      expect(rules).toHaveLength(1 + NUM_DEFAULTS);
      expect(rules.find((r) => r.id === rule.id)).toBeDefined();
    });

    test("trust file has correct structure", () => {
      addRule("bash", "git *", "/tmp");
      const data = JSON.parse(readFileSync(trustPath, "utf-8"));
      expect(data).toHaveProperty("version", 3);
      expect(data).toHaveProperty("rules");
      expect(Array.isArray(data.rules)).toBe(true);
      const userRule = data.rules.find(
        (r: { pattern: string }) => r.pattern === "git *",
      );
      expect(userRule).toHaveProperty("priority", 100);
    });
  });

  // ── deny rules ─────────────────────────────────────────────────

  describe("deny rules", () => {
    test("addRule with deny decision creates a deny rule", () => {
      const rule = addRule("bash", "rm -rf *", "/tmp", "deny");
      expect(rule.decision).toBe("deny");
      expect(rule.tool).toBe("bash");
      expect(rule.pattern).toBe("rm -rf *");
    });

    test("deny rule persists to disk", () => {
      addRule("bash", "rm *", "/tmp", "deny");
      clearCache();
      const rules = getAllRules();
      expect(rules).toHaveLength(1 + NUM_DEFAULTS);
      const userRule = rules.find((r) => r.pattern === "rm *");
      expect(userRule).toBeDefined();
      expect(userRule!.decision).toBe("deny");
    });

    test("findDenyRule finds deny rules", () => {
      addRule("bash", "rm *", "/tmp", "deny");
      const match = findDenyRule("bash", "rm file.txt", "/tmp");
      expect(match).not.toBeNull();
      expect(match!.decision).toBe("deny");
    });

    test("findDenyRule ignores allow rules", () => {
      addRule("bash", "rm *", "/tmp", "allow");
      const match = findDenyRule("bash", "rm file.txt", "/tmp");
      expect(match).toBeNull();
    });

    test("findMatchingRule ignores deny rules", () => {
      // Use host_file_read — it has an 'ask' default so findMatchingRule (allow-only) won't find it.
      addRule("host_file_read", "host_file_read:/etc/*", "/tmp", "deny");
      const match = findMatchingRule(
        "host_file_read",
        "host_file_read:/etc/hosts",
        "/tmp",
      );
      expect(match).toBeNull();
    });

    test("deny and allow rules coexist", () => {
      addRule("bash", "git *", "/tmp", "allow");
      addRule("bash", "git push --force *", "/tmp", "deny");
      expect(findMatchingRule("bash", "git status", "/tmp")).not.toBeNull();
      expect(
        findDenyRule("bash", "git push --force origin", "/tmp"),
      ).not.toBeNull();
    });

    test("deny rule with scope matching", () => {
      addRule("bash", "rm *", "/home/user/project", "deny");
      expect(
        findDenyRule("bash", "rm file.txt", "/home/user/project/sub"),
      ).not.toBeNull();
      expect(findDenyRule("bash", "rm file.txt", "/home/other")).toBeNull();
    });

    test("deny rule with everywhere scope", () => {
      addRule("bash", "rm -rf *", "everywhere", "deny");
      expect(findDenyRule("bash", "rm -rf /", "/any/path")).not.toBeNull();
    });

    test("removeRule works for deny rules", () => {
      const rule = addRule("bash", "rm *", "/tmp", "deny");
      expect(removeRule(rule.id)).toBe(true);
      expect(findDenyRule("bash", "rm file.txt", "/tmp")).toBeNull();
    });
  });

  // ── default rules ─────────────────────────────────────────────

  describe("default rules", () => {
    test("backfills default rules on first load", () => {
      const rules = getAllRules();
      const defaults = rules.filter((r) => r.id.startsWith("default:"));
      expect(defaults).toHaveLength(NUM_DEFAULTS);
      for (const rule of defaults) {
        expect(rule.priority).toBe(DEFAULT_PRIORITY_BY_ID.get(rule.id)!);
        if (
          rule.id === "default:allow-bash-rm-bootstrap" ||
          rule.id === "default:allow-bash-rm-updates"
        ) {
          expect(rule.scope).toBe(join(testDir, "workspace"));
        } else {
          expect(rule.scope).toBe("everywhere");
        }
      }
    });

    test("default rules cover file, host file, host shell, and workspace prompt tools", () => {
      const rules = getAllRules();
      const defaultTools = [
        ...new Set(
          rules.filter((r) => r.id.startsWith("default:")).map((r) => r.tool),
        ),
      ].sort();
      expect(defaultTools).toEqual([
        "bash",
        "browser_click",
        "browser_close",
        "browser_extract",
        "browser_fill_credential",
        "browser_hover",
        "browser_navigate",
        "browser_press_key",
        "browser_screenshot",
        "browser_scroll",
        "browser_select_option",
        "browser_snapshot",
        "browser_type",
        "browser_wait_for",
        "browser_wait_for_download",
        "computer_use_click",
        "computer_use_drag",
        "computer_use_key",
        "computer_use_open_app",
        "computer_use_request_control",
        "computer_use_run_applescript",
        "computer_use_scroll",
        "computer_use_type_text",
        "computer_use_wait",
        "delete_managed_skill",
        "file_edit",
        "file_read",
        "file_write",
        "host_bash",
        "host_file_edit",
        "host_file_read",
        "host_file_write",
        "memory_recall",
        "scaffold_managed_skill",
        "skill_execute",
        "skill_load",
        "ui_dismiss",
        "ui_update",
      ]);
    });

    test("default rules are not duplicated on reload", () => {
      getAllRules(); // first load
      clearCache();
      const rules = getAllRules(); // second load
      const defaults = rules.filter((r) => r.id.startsWith("default:"));
      expect(defaults).toHaveLength(NUM_DEFAULTS);
    });

    test("default rules persist to disk", () => {
      getAllRules(); // triggers backfill + save
      const data = JSON.parse(readFileSync(trustPath, "utf-8"));
      const defaults = data.rules.filter((r: { id: string }) =>
        r.id.startsWith("default:"),
      );
      expect(defaults).toHaveLength(NUM_DEFAULTS);
    });

    test("removed default rule is re-backfilled on next load", () => {
      // First load backfills defaults
      getAllRules();
      // Remove one default rule by editing trust.json directly on disk
      // (removeRule() throws for default rules, so we simulate external editing)
      const raw = JSON.parse(readFileSync(trustPath, "utf-8"));
      raw.rules = raw.rules.filter(
        (r: { id: string }) => r.id !== "default:ask-host_file_read-global",
      );
      writeFileSync(trustPath, JSON.stringify(raw, null, 2));
      // After reload, the rule is re-backfilled (defaults are always present)
      clearCache();
      const rules = getAllRules();
      expect(
        rules.find((r) => r.id === "default:ask-host_file_read-global"),
      ).toBeDefined();
    });

    test("findHighestPriorityRule matches default ask for host_file_read", () => {
      const match = findHighestPriorityRule(
        "host_file_read",
        ["host_file_read:/etc/hosts"],
        "/tmp",
      );
      expect(match).not.toBeNull();
      expect(match!.id).toBe("default:ask-host_file_read-global");
      expect(match!.decision).toBe("ask");
      expect(match!.priority).toBe(
        DEFAULT_PRIORITY_BY_ID.get("default:ask-host_file_read-global")!,
      );
    });

    test("findHighestPriorityRule matches default ask for host_file_write", () => {
      const match = findHighestPriorityRule(
        "host_file_write",
        ["host_file_write:/etc/hosts"],
        "/tmp",
      );
      expect(match).not.toBeNull();
      expect(match!.id).toBe("default:ask-host_file_write-global");
      expect(match!.decision).toBe("ask");
      expect(match!.priority).toBe(
        DEFAULT_PRIORITY_BY_ID.get("default:ask-host_file_write-global")!,
      );
    });

    test("findHighestPriorityRule matches default ask for host_file_edit", () => {
      const match = findHighestPriorityRule(
        "host_file_edit",
        ["host_file_edit:/etc/hosts"],
        "/tmp",
      );
      expect(match).not.toBeNull();
      expect(match!.id).toBe("default:ask-host_file_edit-global");
      expect(match!.decision).toBe("ask");
      expect(match!.priority).toBe(
        DEFAULT_PRIORITY_BY_ID.get("default:ask-host_file_edit-global")!,
      );
    });

    test("findHighestPriorityRule matches default ask for host_bash", () => {
      const match = findHighestPriorityRule("host_bash", ["ls"], "/tmp");
      expect(match).not.toBeNull();
      expect(match!.id).toBe("default:ask-host_bash-global");
      expect(match!.decision).toBe("ask");
      expect(match!.priority).toBe(
        DEFAULT_PRIORITY_BY_ID.get("default:ask-host_bash-global")!,
      );
    });

    test("findHighestPriorityRule matches default ask for computer_use_click", () => {
      const match = findHighestPriorityRule(
        "computer_use_click",
        ["computer_use_click:"],
        "/tmp",
      );
      expect(match).not.toBeNull();
      expect(match!.id).toBe("default:ask-computer_use_click-global");
      expect(match!.decision).toBe("ask");
      expect(match!.priority).toBe(
        DEFAULT_PRIORITY_BY_ID.get("default:ask-computer_use_click-global")!,
      );
    });

    test("findHighestPriorityRule matches default ask for computer_use_request_control", () => {
      const match = findHighestPriorityRule(
        "computer_use_request_control",
        ["computer_use_request_control:"],
        "/tmp",
      );
      expect(match).not.toBeNull();
      expect(match!.id).toBe("default:ask-computer_use_request_control-global");
      expect(match!.decision).toBe("ask");
      expect(match!.priority).toBe(
        DEFAULT_PRIORITY_BY_ID.get(
          "default:ask-computer_use_request_control-global",
        )!,
      );
    });

    test("bootstrap delete rule matches only when workingDir is the workspace dir", () => {
      const workspaceDir = join(testDir, "workspace");
      // Should match when workingDir is the workspace directory — the bootstrap
      // rule (priority 100) outranks the global default allow (priority 50).
      const match = findHighestPriorityRule(
        "bash",
        ["rm BOOTSTRAP.md"],
        workspaceDir,
      );
      expect(match).not.toBeNull();
      expect(match!.id).toBe("default:allow-bash-rm-bootstrap");
      expect(match!.decision).toBe("allow");
      expect(match!.allowHighRisk).toBe(true);
      // Outside workspace, the bootstrap rule doesn't match — the global
      // default:allow-bash-global rule matches instead (not the bootstrap rule).
      const other = findHighestPriorityRule(
        "bash",
        ["rm BOOTSTRAP.md"],
        "/tmp/other-project",
      );
      expect(other).not.toBeNull();
      expect(other!.id).not.toBe("default:allow-bash-rm-bootstrap");
      expect(other!.id).toBe("default:allow-bash-global");
    });

    test("updates delete rule matches only when workingDir is the workspace dir", () => {
      const workspaceDir = join(testDir, "workspace");
      const match = findHighestPriorityRule(
        "bash",
        ["rm UPDATES.md"],
        workspaceDir,
      );
      expect(match).not.toBeNull();
      expect(match!.id).toBe("default:allow-bash-rm-updates");
      expect(match!.decision).toBe("allow");
      expect(match!.allowHighRisk).toBe(true);
      // Outside workspace, should NOT match the updates rule
      const other = findHighestPriorityRule(
        "bash",
        ["rm UPDATES.md"],
        "/tmp/other-project",
      );
      expect(other).not.toBeNull();
      expect(other!.id).not.toBe("default:allow-bash-rm-updates");
    });

    test("default ask does not affect files outside protected directory", () => {
      const safePath = join(testDir, "data", "assistant.db");
      const match = findHighestPriorityRule(
        "file_read",
        [`file_read:${safePath}`],
        "/tmp",
      );
      // Should not match a default deny rule
      expect(match == null || !match.id.startsWith("default:")).toBe(true);
    });

    test("default rules are backfilled after malformed JSON in trust file", () => {
      mkdirSync(dirname(trustPath), { recursive: true });
      writeFileSync(trustPath, "NOT VALID JSON {{{");
      clearCache();
      const rules = getAllRules();
      const defaults = rules.filter((r) => r.id.startsWith("default:"));
      expect(defaults).toHaveLength(NUM_DEFAULTS);
    });

    test("default rules are backfilled in-memory after unknown file version without overwriting disk", () => {
      mkdirSync(dirname(trustPath), { recursive: true });
      const originalContent = JSON.stringify({
        version: 9999,
        rules: [
          {
            id: "future-rule",
            tool: "bash",
            pattern: "future *",
            scope: "everywhere",
            decision: "allow",
            priority: 50,
            createdAt: 1000,
          },
        ],
      });
      writeFileSync(trustPath, originalContent);
      clearCache();
      const rules = getAllRules();
      // Defaults should be present in-memory
      const defaults = rules.filter((r) => r.id.startsWith("default:"));
      expect(defaults).toHaveLength(NUM_DEFAULTS);
      // The on-disk file must NOT be overwritten — it preserves the unknown format
      const diskContent = readFileSync(trustPath, "utf-8");
      expect(diskContent).toBe(originalContent);
    });

    test("clearAllRules preserves default rules", () => {
      addRule("bash", "git *", "/tmp");
      clearAllRules();
      const rules = getAllRules();
      // User rules should be gone, but defaults should remain
      expect(rules.filter((r) => !r.id.startsWith("default:"))).toHaveLength(0);
      const defaults = rules.filter((r) => r.id.startsWith("default:"));
      expect(defaults).toHaveLength(NUM_DEFAULTS);
    });

    // ── skill source mutation rules ────────────────────────────────

    test("default rules include ask rules for file_write on skill source paths", () => {
      const rules = getAllRules();
      const managed = rules.find(
        (r) => r.id === "default:ask-file_write-managed-skills",
      );
      expect(managed).toBeDefined();
      expect(managed!.tool).toBe("file_write");
      expect(managed!.decision).toBe("ask");
      expect(managed!.priority).toBe(50);
      expect(managed!.pattern).toContain("workspace/skills/**");

      const bundled = rules.find(
        (r) => r.id === "default:ask-file_write-bundled-skills",
      );
      expect(bundled).toBeDefined();
      expect(bundled!.tool).toBe("file_write");
      expect(bundled!.decision).toBe("ask");
      expect(bundled!.priority).toBe(50);
    });

    test("default rules include ask rules for file_edit on skill source paths", () => {
      const rules = getAllRules();
      const managed = rules.find(
        (r) => r.id === "default:ask-file_edit-managed-skills",
      );
      expect(managed).toBeDefined();
      expect(managed!.tool).toBe("file_edit");
      expect(managed!.decision).toBe("ask");
      expect(managed!.priority).toBe(50);
      expect(managed!.pattern).toContain("workspace/skills/**");

      const bundled = rules.find(
        (r) => r.id === "default:ask-file_edit-bundled-skills",
      );
      expect(bundled).toBeDefined();
      expect(bundled!.tool).toBe("file_edit");
      expect(bundled!.decision).toBe("ask");
      expect(bundled!.priority).toBe(50);
    });

    // ── default allow: skill_load ────────────────────────────────

    test("skill_load default allow rule exists in templates", () => {
      const templates = getDefaultRuleTemplates();
      const skillLoadRule = templates.find(
        (t) => t.id === "default:allow-skill_load-global",
      );
      expect(skillLoadRule).toBeDefined();
      expect(skillLoadRule!.tool).toBe("skill_load");
      expect(skillLoadRule!.pattern).toBe("skill_load:*");
      expect(skillLoadRule!.decision).toBe("allow");
      expect(skillLoadRule!.scope).toBe("everywhere");
    });

    test("findHighestPriorityRule matches default allow for skill_load", () => {
      const match = findHighestPriorityRule(
        "skill_load",
        ["skill_load:browser"],
        "/tmp",
      );
      expect(match).not.toBeNull();
      expect(match!.id).toBe("default:allow-skill_load-global");
      expect(match!.decision).toBe("allow");
      expect(match!.priority).toBe(100);
    });

    test("findHighestPriorityRule matches default allow for skill_load with any skill name", () => {
      const match = findHighestPriorityRule(
        "skill_load",
        ["skill_load:some-random-skill"],
        "/tmp",
      );
      expect(match).not.toBeNull();
      expect(match!.id).toBe("default:allow-skill_load-global");
      expect(match!.decision).toBe("allow");
    });

    // ── default allow: browser tools ────────────────────────────

    test("all 10 browser tools have default allow rules", () => {
      const templates = getDefaultRuleTemplates();
      const browserTools = [
        "browser_navigate",
        "browser_snapshot",
        "browser_screenshot",
        "browser_close",
        "browser_click",
        "browser_type",
        "browser_press_key",
        "browser_wait_for",
        "browser_extract",
        "browser_fill_credential",
      ];

      for (const tool of browserTools) {
        const rule = templates.find(
          (t) => t.id === `default:allow-${tool}-global`,
        );
        expect(rule).toBeDefined();
        expect(rule!.tool).toBe(tool);
        // browser_navigate uses standalone "**" because its candidates
        // contain URLs with "/" that single "*" cannot match.
        const expectedPattern =
          tool === "browser_navigate" ? "**" : `${tool}:*`;
        expect(rule!.pattern).toBe(expectedPattern);
        expect(rule!.decision).toBe("allow");
        expect(rule!.scope).toBe("everywhere");
      }
    });

    test("browser tool default rules match via findHighestPriorityRule", () => {
      // Use a candidate without slashes so the `browser_snapshot:*` pattern
      // matches (minimatch `*` does not cross `/` boundaries).
      const result = findHighestPriorityRule(
        "browser_snapshot",
        ["browser_snapshot:"],
        "/tmp",
      );
      expect(result).toBeDefined();
      expect(result!.decision).toBe("allow");
    });

    test("no default ask rules exist for file_read on skill source paths", () => {
      const rules = getAllRules();
      // There should be no default rules with IDs matching file_read for skill sources
      const readManagedSkill = rules.find(
        (r) => r.id === "default:ask-file_read-managed-skills",
      );
      const readBundledSkill = rules.find(
        (r) => r.id === "default:ask-file_read-bundled-skills",
      );
      expect(readManagedSkill).toBeUndefined();
      expect(readBundledSkill).toBeUndefined();
    });

    test("findHighestPriorityRule matches default ask for file_write on managed skill path", () => {
      const skillFile = join(
        testDir,
        "workspace",
        "skills",
        "my-skill",
        "SKILL.md",
      );
      const match = findHighestPriorityRule(
        "file_write",
        [`file_write:${skillFile}`],
        "/tmp",
      );
      expect(match).not.toBeNull();
      expect(match!.id).toBe("default:ask-file_write-managed-skills");
      expect(match!.decision).toBe("ask");
    });

    test("findHighestPriorityRule matches default ask for file_edit on managed skill path", () => {
      const skillFile = join(
        testDir,
        "workspace",
        "skills",
        "my-skill",
        "tools.ts",
      );
      const match = findHighestPriorityRule(
        "file_edit",
        [`file_edit:${skillFile}`],
        "/tmp",
      );
      expect(match).not.toBeNull();
      expect(match!.id).toBe("default:ask-file_edit-managed-skills");
      expect(match!.decision).toBe("ask");
    });
  });

  // ── trust rule schema v3 (PR 14) ──────────────────────────────

  describe("trust rule schema v3 (PR 14)", () => {
    test("new rules can include v3 optional fields", () => {
      const rule = addRule("bash", "git *", "/tmp");
      // Manually set v3 optional fields on the rule and persist
      rule.executionTarget = "/usr/local/bin/node";
      rule.allowHighRisk = true;
      // Re-persist the updated rules
      const rules = getAllRules().map((r) => (r.id === rule.id ? rule : r));
      // Write directly to verify round-trip
      const trustData = { version: 3, rules };
      writeFileSync(trustPath, JSON.stringify(trustData, null, 2));
      clearCache();
      const reloaded = getAllRules();
      const found = reloaded.find((r) => r.id === rule.id);
      expect(found).toBeDefined();
      expect(found!.executionTarget).toBe("/usr/local/bin/node");
      expect(found!.allowHighRisk).toBe(true);
    });

    test("trust file persists with version 3", () => {
      addRule("bash", "echo *", "/tmp");
      const data = JSON.parse(readFileSync(trustPath, "utf-8"));
      expect(data.version).toBe(3);
    });
  });

  // ── loadFromDisk resilience (misc) ──────────────────────────────

  describe("loadFromDisk resilience (misc)", () => {
    test("migrates legacy root trust file to protected path", () => {
      mkdirSync(dirname(legacyTrustPath), { recursive: true });
      writeFileSync(
        legacyTrustPath,
        JSON.stringify({
          version: 3,
          rules: [
            {
              id: "legacy-deny",
              tool: "host_bash",
              pattern: "rm -rf *",
              scope: "everywhere",
              decision: "deny",
              priority: 200,
              createdAt: 123,
            },
          ],
        }),
      );

      clearCache();
      const rules = getAllRules();

      expect(rules.find((r) => r.id === "legacy-deny")).toBeDefined();
      expect(readFileSync(trustPath, "utf-8")).toContain("legacy-deny");
      expect(() => readFileSync(legacyTrustPath, "utf-8")).toThrow();
    });

    test("prefers protected trust file when both protected and legacy files exist", () => {
      mkdirSync(dirname(trustPath), { recursive: true });
      writeFileSync(
        trustPath,
        JSON.stringify({
          version: 3,
          rules: [
            {
              id: "protected-rule",
              tool: "bash",
              pattern: "protected *",
              scope: "/tmp",
              decision: "allow",
              priority: 100,
              createdAt: 1,
            },
          ],
        }),
      );
      writeFileSync(
        legacyTrustPath,
        JSON.stringify({
          version: 3,
          rules: [
            {
              id: "legacy-rule",
              tool: "bash",
              pattern: "legacy *",
              scope: "/tmp",
              decision: "deny",
              priority: 200,
              createdAt: 2,
            },
          ],
        }),
      );

      clearCache();
      const rules = getAllRules();

      expect(rules.find((r) => r.id === "protected-rule")).toBeDefined();
      expect(rules.find((r) => r.id === "legacy-rule")).toBeUndefined();
      expect(readFileSync(legacyTrustPath, "utf-8")).toContain("legacy-rule");
    });

    test("malformed file (valid JSON but null) is handled gracefully", () => {
      mkdirSync(dirname(trustPath), { recursive: true });
      writeFileSync(trustPath, "null");
      clearCache();
      const rules = getAllRules();
      // Accessing null.version throws TypeError, caught by try/catch,
      // falls through to backfill defaults
      expect(rules).toHaveLength(NUM_DEFAULTS);
    });

    test("v3 file with optional fields is loaded correctly without re-migration", () => {
      mkdirSync(dirname(trustPath), { recursive: true });
      const v3Rules = [
        {
          id: "v3-with-options",
          tool: "bash",
          pattern: "skill-cmd *",
          scope: "/tmp",
          decision: "allow",
          priority: 100,
          createdAt: 7000,
          executionTarget: "/usr/bin/node",
          allowHighRisk: false,
        },
        {
          id: "v3-without-options",
          tool: "bash",
          pattern: "git *",
          scope: "/tmp",
          decision: "allow",
          priority: 100,
          createdAt: 7001,
        },
      ];
      writeFileSync(trustPath, JSON.stringify({ version: 3, rules: v3Rules }));
      clearCache();
      const rules = getAllRules();

      // Rule with optional fields should have them preserved
      const withOptions = rules.find((r) => r.id === "v3-with-options");
      expect(withOptions).toBeDefined();
      expect(withOptions!.executionTarget).toBe("/usr/bin/node");
      expect(withOptions!.allowHighRisk).toBe(false);

      // Rule without optional fields should remain without them
      const withoutOptions = rules.find((r) => r.id === "v3-without-options");
      expect(withoutOptions).toBeDefined();
      expect(withoutOptions).not.toHaveProperty("executionTarget");
    });

    test("legacy v2 version migrates rules and persists as v3", () => {
      mkdirSync(dirname(trustPath), { recursive: true });
      writeFileSync(
        trustPath,
        JSON.stringify({
          version: 2,
          rules: [
            {
              id: "old-version-rule",
              tool: "bash",
              pattern: "git *",
              scope: "/tmp",
              decision: "allow",
              priority: 100,
              createdAt: 5000,
            },
          ],
        }),
      );
      clearCache();
      const rules = getAllRules();
      const migratedRule = rules.find((r) => r.id === "old-version-rule");
      expect(migratedRule).toBeDefined();
      expect(migratedRule!.decision).toBe("allow");
      expect(rules).toHaveLength(1 + NUM_DEFAULTS);

      // File should be persisted to the current schema version.
      const data = JSON.parse(readFileSync(trustPath, "utf-8"));
      expect(data.version).toBe(3);
      expect(
        data.rules.some((r: { id: string }) => r.id === "old-version-rule"),
      ).toBe(true);
    });

    test("legacy v1 version migrates rules and persists as v3", () => {
      mkdirSync(dirname(trustPath), { recursive: true });
      writeFileSync(
        trustPath,
        JSON.stringify({
          version: 1,
          rules: [
            {
              id: "v1-rule",
              tool: "bash",
              pattern: "rm *",
              scope: "everywhere",
              decision: "deny",
              priority: 200,
              createdAt: 4000,
            },
          ],
        }),
      );

      clearCache();
      const rules = getAllRules();
      const migratedRule = rules.find((r) => r.id === "v1-rule");
      expect(migratedRule).toBeDefined();
      expect(migratedRule!.decision).toBe("deny");

      const data = JSON.parse(readFileSync(trustPath, "utf-8"));
      expect(data.version).toBe(3);
      expect(data.rules.some((r: { id: string }) => r.id === "v1-rule")).toBe(
        true,
      );
    });
  });

  // ── executionTarget-aware rule matching ──────────────────────

  describe("executionTarget-aware rule matching", () => {
    /**
     * Helper: write a v3 trust file with the given rules directly to disk,
     * then clear the cache so the next getRules() call picks them up.
     */
    function seedRules(rules: Array<Record<string, unknown>>): void {
      mkdirSync(dirname(trustPath), { recursive: true });
      writeFileSync(trustPath, JSON.stringify({ version: 3, rules }));
      clearCache();
    }

    // ── wildcard semantics (no executionTarget on rule) ──────────

    describe("wildcard semantics — rules without executionTarget", () => {
      test("rule with no executionTarget matches when no context is provided", () => {
        addRule("bash", "git *", "/tmp", "allow", 200);
        const match = findHighestPriorityRule("bash", ["git status"], "/tmp");
        expect(match).not.toBeNull();
        expect(match!.decision).toBe("allow");
      });

      test("rule with no executionTarget matches any execution target", () => {
        addRule("bash", "git *", "/tmp", "allow", 200);
        const match = findHighestPriorityRule("bash", ["git status"], "/tmp", {
          executionTarget: "/usr/bin/node",
        });
        expect(match).not.toBeNull();
        expect(match!.decision).toBe("allow");
      });
    });

    // ── executionTarget matching ──────────────────────────────────

    describe("executionTarget matching", () => {
      test("rule with executionTarget matches exact target", () => {
        seedRules([
          {
            id: "et-exact",
            tool: "bash",
            pattern: "run *",
            scope: "everywhere",
            decision: "allow",
            priority: 200,
            createdAt: Date.now(),
            executionTarget: "/usr/local/bin/node",
          },
        ]);
        const match = findHighestPriorityRule(
          "bash",
          ["run script.js"],
          "/tmp",
          {
            executionTarget: "/usr/local/bin/node",
          },
        );
        expect(match).not.toBeNull();
        expect(match!.id).toBe("et-exact");
      });

      test("rule with executionTarget does NOT match different target", () => {
        seedRules([
          {
            id: "et-diff",
            tool: "bash",
            pattern: "run *",
            scope: "everywhere",
            decision: "allow",
            priority: 200,
            createdAt: Date.now(),
            executionTarget: "/usr/local/bin/node",
          },
        ]);
        const match = findHighestPriorityRule(
          "bash",
          ["run script.js"],
          "/tmp",
          {
            executionTarget: "/usr/local/bin/bun",
          },
        );
        expect(match == null || match.id !== "et-diff").toBe(true);
      });

      test("rule with executionTarget does NOT match when no target in context", () => {
        seedRules([
          {
            id: "et-no-ctx",
            tool: "bash",
            pattern: "run *",
            scope: "everywhere",
            decision: "allow",
            priority: 200,
            createdAt: Date.now(),
            executionTarget: "/usr/local/bin/node",
          },
        ]);
        const match = findHighestPriorityRule(
          "bash",
          ["run script.js"],
          "/tmp",
          {},
        );
        expect(match == null || match.id !== "et-no-ctx").toBe(true);
      });

      test("rule WITHOUT executionTarget matches any target (wildcard)", () => {
        addRule("bash", "run *", "/tmp", "allow", 200);
        const match = findHighestPriorityRule(
          "bash",
          ["run script.js"],
          "/tmp",
          {
            executionTarget: "/any/path/to/runtime",
          },
        );
        expect(match).not.toBeNull();
        expect(match!.pattern).toBe("run *");
      });
    });

    // ── backward compatibility ────────────────────────────────────

    describe("backward compatibility", () => {
      test("existing callers without ctx parameter still work", () => {
        addRule("bash", "git *", "/tmp", "allow", 200);
        // Calling without the 4th argument — must still match
        const match = findHighestPriorityRule("bash", ["git status"], "/tmp");
        expect(match).not.toBeNull();
        expect(match!.pattern).toBe("git *");
      });

      test("empty PolicyContext object behaves the same as no context", () => {
        addRule("bash", "ls *", "/tmp", "allow", 200);
        const matchNoCtx = findHighestPriorityRule("bash", ["ls -la"], "/tmp");
        const matchEmptyCtx = findHighestPriorityRule(
          "bash",
          ["ls -la"],
          "/tmp",
          {},
        );
        expect(matchNoCtx).not.toBeNull();
        expect(matchEmptyCtx).not.toBeNull();
        expect(matchNoCtx!.id).toBe(matchEmptyCtx!.id);
      });
    });
  });

  // ── network_request trust rule matching ────────────────────────

  describe("network_request trust rules", () => {
    test("exact origin rule matches network_request candidates", () => {
      addRule(
        "network_request",
        "network_request:https://api.example.com/*",
        "everywhere",
      );
      const rule = findHighestPriorityRule(
        "network_request",
        [
          "network_request:https://api.example.com/v1/data",
          "network_request:https://api.example.com/*",
        ],
        "/tmp",
      );
      expect(rule).not.toBeNull();
      expect(rule!.decision).toBe("allow");
    });

    test("exact url rule matches only that url candidate", () => {
      addRule(
        "network_request",
        "network_request:https://api.example.com/v1/data",
        "everywhere",
      );
      const match = findHighestPriorityRule(
        "network_request",
        [
          "network_request:https://api.example.com/v1/data",
          "network_request:https://api.example.com/*",
        ],
        "/tmp",
      );
      expect(match).not.toBeNull();

      const noMatch = findHighestPriorityRule(
        "network_request",
        ["network_request:https://api.example.com/v2/other"],
        "/tmp",
      );
      expect(noMatch).toBeNull();
    });

    test("globstar rule matches any network_request candidate", () => {
      // minimatch treats standalone "**" as globstar (matching "/"), but
      // "network_request:*" uses single "*" which doesn't cross slashes.
      // The tool field is already filtered by findHighestPriorityRule, so
      // "**" is the correct catch-all pattern.
      addRule("network_request", "**", "everywhere");
      const rule = findHighestPriorityRule(
        "network_request",
        ["network_request:https://any-host.example.org/path"],
        "/tmp",
      );
      expect(rule).not.toBeNull();
    });

    test("single-star wildcard matches flat candidates only", () => {
      // "network_request:*" won't match URLs with slashes — consistent
      // with the behavior of web_fetch:* and browser_navigate:* patterns.
      addRule("network_request", "network_request:*", "everywhere");
      const noSlashMatch = findHighestPriorityRule(
        "network_request",
        ["network_request:flat-target"],
        "/tmp",
      );
      expect(noSlashMatch).not.toBeNull();

      const slashNoMatch = findHighestPriorityRule(
        "network_request",
        ["network_request:https://example.com/path"],
        "/tmp",
      );
      // Single "*" does not match "/" so this URL candidate won't match.
      expect(slashNoMatch).toBeNull();
    });

    test("network_request rule does not match web_fetch tool", () => {
      addRule(
        "network_request",
        "network_request:https://api.example.com/*",
        "everywhere",
      );
      const rule = findHighestPriorityRule(
        "web_fetch",
        [
          "web_fetch:https://api.example.com/v1/data",
          "web_fetch:https://api.example.com/*",
        ],
        "/tmp",
      );
      expect(rule).toBeNull();
    });

    test("web_fetch rule does not match network_request tool", () => {
      addRule("web_fetch", "web_fetch:https://api.example.com/*", "everywhere");
      const rule = findHighestPriorityRule(
        "network_request",
        [
          "network_request:https://api.example.com/v1/data",
          "network_request:https://api.example.com/*",
        ],
        "/tmp",
      );
      expect(rule).toBeNull();
    });

    test("deny rule takes precedence over allow at same priority", () => {
      addRule(
        "network_request",
        "network_request:https://api.example.com/*",
        "everywhere",
        "allow",
        100,
      );
      addRule(
        "network_request",
        "network_request:https://api.example.com/*",
        "everywhere",
        "deny",
        100,
      );
      const rule = findHighestPriorityRule(
        "network_request",
        [
          "network_request:https://api.example.com/v1/data",
          "network_request:https://api.example.com/*",
        ],
        "/tmp",
      );
      expect(rule).not.toBeNull();
      expect(rule!.decision).toBe("deny");
    });

    test("higher-priority allow overrides lower-priority deny", () => {
      addRule(
        "network_request",
        "network_request:https://api.example.com/*",
        "everywhere",
        "deny",
        50,
      );
      addRule(
        "network_request",
        "network_request:https://api.example.com/*",
        "everywhere",
        "allow",
        100,
      );
      const rule = findHighestPriorityRule(
        "network_request",
        [
          "network_request:https://api.example.com/v1/data",
          "network_request:https://api.example.com/*",
        ],
        "/tmp",
      );
      expect(rule).not.toBeNull();
      expect(rule!.decision).toBe("allow");
    });

    test("scope restricts network_request rule matching", () => {
      addRule(
        "network_request",
        "network_request:https://api.example.com/*",
        "/home/user/project",
      );
      const inScope = findHighestPriorityRule(
        "network_request",
        ["network_request:https://api.example.com/*"],
        "/home/user/project",
      );
      expect(inScope).not.toBeNull();

      const outOfScope = findHighestPriorityRule(
        "network_request",
        ["network_request:https://api.example.com/*"],
        "/tmp/other",
      );
      expect(outOfScope).toBeNull();
    });
  });
});

describe("computer-use tool trust rule matching", () => {
  test("actionable CU tools have default ask trust rules", () => {
    // Actionable CU tools (those that perform screen interactions) should
    // have default "ask" rules so strict mode prompts before use.
    const actionableCuTools = [
      "computer_use_click",
      "computer_use_type_text",
      "computer_use_request_control",
    ];

    for (const name of actionableCuTools) {
      const rule = findHighestPriorityRule(name, [name], "/tmp/test");
      expect(rule).not.toBeNull();
      expect(rule!.decision).toBe("ask");
    }
  });

  test("terminal CU tools (done/respond) have no default trust rules", () => {
    // computer_use_done and computer_use_respond are terminal signal tools
    // with RiskLevel.Low — they should not have ask rules since they don't
    // perform any screen action.
    const terminalCuTools = ["computer_use_done", "computer_use_respond"];

    for (const name of terminalCuTools) {
      const defaultRule = DEFAULT_TEMPLATES.find((t) => t.tool === name);
      expect(defaultRule).toBeUndefined();
    }
  });
});
