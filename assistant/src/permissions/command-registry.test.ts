import { describe, expect, test } from "bun:test";

import { DEFAULT_COMMAND_REGISTRY } from "./command-registry.js";
import type { ArgRule, CommandRiskSpec } from "./risk-types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Collect all ArgRule ids from a CommandRiskSpec tree (recursive). */
function collectArgRuleIds(
  spec: CommandRiskSpec,
  prefix: string,
): { id: string; path: string }[] {
  const results: { id: string; path: string }[] = [];
  if (spec.argRules) {
    for (const rule of spec.argRules) {
      results.push({ id: rule.id, path: prefix });
    }
  }
  if (spec.subcommands) {
    for (const [sub, subSpec] of Object.entries(spec.subcommands)) {
      results.push(...collectArgRuleIds(subSpec, `${prefix} ${sub}`));
    }
  }
  return results;
}

/** Collect all ArgRules from a CommandRiskSpec tree (recursive). */
function collectArgRules(spec: CommandRiskSpec): ArgRule[] {
  const results: ArgRule[] = [];
  if (spec.argRules) {
    results.push(...spec.argRules);
  }
  if (spec.subcommands) {
    for (const subSpec of Object.values(spec.subcommands)) {
      results.push(...collectArgRules(subSpec));
    }
  }
  return results;
}

/** Collect all baseRisk values from a CommandRiskSpec tree (recursive). */
function collectBaseRisks(spec: CommandRiskSpec): string[] {
  const results: string[] = [spec.baseRisk];
  if (spec.subcommands) {
    for (const subSpec of Object.values(spec.subcommands)) {
      results.push(...collectBaseRisks(subSpec));
    }
  }
  return results;
}

// ── LOW_RISK_PROGRAMS from checker.ts ────────────────────────────────────────
// Replicated here for test validation. Every program in this set must have an
// entry in the registry.
const LOW_RISK_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "file", "stat",
  "grep", "rg", "ag", "ack", "find", "fd", "which", "where", "whereis",
  "type", "echo", "printf", "date", "cal", "uptime", "whoami", "hostname",
  "uname", "pwd", "realpath", "dirname", "basename", "git", "node", "bun",
  "deno", "npm", "npx", "yarn", "pnpm", "python", "python3", "pip", "pip3",
  "man", "help", "info", "env", "printenv", "set", "diff", "sort", "uniq",
  "cut", "tr", "tee", "xargs", "jq", "yq", "http", "dig", "nslookup",
  "ping", "tree", "du", "df",
]);

// ── HIGH_RISK_PROGRAMS from checker.ts ───────────────────────────────────────
const HIGH_RISK_PROGRAMS = new Set([
  "sudo", "su", "doas", "dd", "mkfs", "fdisk", "parted", "mount", "umount",
  "systemctl", "service", "launchctl", "useradd", "userdel", "usermod",
  "groupadd", "groupdel", "iptables", "ufw", "firewall-cmd", "reboot",
  "shutdown", "halt", "poweroff", "kill", "killall", "pkill",
]);

// ── WRAPPER_PROGRAMS from checker.ts ─────────────────────────────────────────
const WRAPPER_PROGRAMS = new Set([
  "env", "nice", "nohup", "time", "command", "exec", "strace", "ltrace",
  "ionice", "taskset", "timeout",
]);

// ── LOW_RISK_GIT_SUBCOMMANDS from checker.ts ─────────────────────────────────
const LOW_RISK_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "tag", "remote", "stash",
  "blame", "shortlog", "describe", "rev-parse", "ls-files", "ls-tree",
  "cat-file", "reflog",
]);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("command-registry", () => {
  describe("structure validation", () => {
    test("every entry has a valid baseRisk", () => {
      const validRisks = new Set(["low", "medium", "high"]);
      for (const [name, spec] of Object.entries(DEFAULT_COMMAND_REGISTRY)) {
        const allRisks = collectBaseRisks(spec);
        for (const risk of allRisks) {
          expect(validRisks.has(risk)).toBe(true);
        }
      }
    });

    test("every ArgRule has a unique id across the entire registry", () => {
      const allIds: { id: string; path: string }[] = [];
      for (const [name, spec] of Object.entries(DEFAULT_COMMAND_REGISTRY)) {
        allIds.push(...collectArgRuleIds(spec, name));
      }

      const seen = new Map<string, string>();
      const duplicates: string[] = [];
      for (const { id, path } of allIds) {
        if (seen.has(id)) {
          duplicates.push(`"${id}" appears in both "${seen.get(id)}" and "${path}"`);
        }
        seen.set(id, path);
      }

      expect(duplicates).toEqual([]);
    });

    test("every valuePattern compiles as valid RegExp", () => {
      const errors: string[] = [];
      for (const [name, spec] of Object.entries(DEFAULT_COMMAND_REGISTRY)) {
        const allRules = collectArgRules(spec);
        for (const rule of allRules) {
          if (rule.valuePattern) {
            try {
              new RegExp(rule.valuePattern);
            } catch (e) {
              errors.push(`${name}/${rule.id}: ${rule.valuePattern} — ${e}`);
            }
          }
        }
      }
      expect(errors).toEqual([]);
    });

    test("every ArgRule risk is a valid RegistryRisk", () => {
      const validRisks = new Set(["low", "medium", "high"]);
      for (const [name, spec] of Object.entries(DEFAULT_COMMAND_REGISTRY)) {
        const allRules = collectArgRules(spec);
        for (const rule of allRules) {
          expect(validRisks.has(rule.risk)).toBe(true);
        }
      }
    });
  });

  describe("coverage of checker.ts programs", () => {
    test("every program in LOW_RISK_PROGRAMS has a registry entry", () => {
      const missing: string[] = [];
      for (const prog of LOW_RISK_PROGRAMS) {
        if (!(prog in DEFAULT_COMMAND_REGISTRY)) {
          missing.push(prog);
        }
      }
      expect(missing).toEqual([]);
    });

    test("every program in HIGH_RISK_PROGRAMS has a registry entry", () => {
      const missing: string[] = [];
      for (const prog of HIGH_RISK_PROGRAMS) {
        if (!(prog in DEFAULT_COMMAND_REGISTRY)) {
          missing.push(prog);
        }
      }
      expect(missing).toEqual([]);
    });

    test("every program in WRAPPER_PROGRAMS has isWrapper: true", () => {
      const errors: string[] = [];
      for (const prog of WRAPPER_PROGRAMS) {
        const spec = (DEFAULT_COMMAND_REGISTRY as Record<string, CommandRiskSpec>)[prog];
        if (!spec) {
          errors.push(`${prog}: missing from registry`);
        } else if (!spec.isWrapper) {
          errors.push(`${prog}: isWrapper is not true`);
        }
      }
      expect(errors).toEqual([]);
    });

    test("every subcommand in LOW_RISK_GIT_SUBCOMMANDS exists under git subcommands", () => {
      const gitSpec = DEFAULT_COMMAND_REGISTRY.git;
      expect(gitSpec).toBeDefined();
      expect(gitSpec.subcommands).toBeDefined();

      const missing: string[] = [];
      for (const sub of LOW_RISK_GIT_SUBCOMMANDS) {
        if (!gitSpec.subcommands![sub]) {
          missing.push(sub);
        }
      }
      expect(missing).toEqual([]);
    });

    test("every LOW_RISK_GIT_SUBCOMMAND has baseRisk low in the registry", () => {
      const gitSpec = DEFAULT_COMMAND_REGISTRY.git;
      const errors: string[] = [];

      for (const sub of LOW_RISK_GIT_SUBCOMMANDS) {
        const subSpec = gitSpec.subcommands![sub];
        if (subSpec && subSpec.baseRisk !== "low") {
          // stash is an exception — its baseRisk is "medium" (write operation)
          // but it was in LOW_RISK_GIT_SUBCOMMANDS because `git stash` without
          // args defaults to `git stash push`, and the checker treated the bare
          // command as low. Our registry has it as medium with low subcommands.
          if (sub === "stash") continue;
          errors.push(`git ${sub}: expected baseRisk "low", got "${subSpec.baseRisk}"`);
        }
      }

      expect(errors).toEqual([]);
    });
  });

  describe("registry entry count", () => {
    test("has at least 90 entries (comprehensive coverage)", () => {
      const count = Object.keys(DEFAULT_COMMAND_REGISTRY).length;
      expect(count).toBeGreaterThanOrEqual(90);
    });
  });
});
