import { describe, expect, test } from "bun:test";

import { DEFAULT_COMMAND_REGISTRY } from "./command-registry/index.js";
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
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "file",
  "stat",
  "grep",
  "rg",
  "ag",
  "ack",
  "find",
  "fd",
  "which",
  "where",
  "whereis",
  "type",
  "echo",
  "printf",
  "date",
  "cal",
  "uptime",
  "whoami",
  "hostname",
  "uname",
  "pwd",
  "realpath",
  "dirname",
  "basename",
  "git",
  "node",
  "bun",
  "deno",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "python",
  "python3",
  "pip",
  "pip3",
  "man",
  "help",
  "info",
  "env",
  "printenv",
  "set",
  "diff",
  "sort",
  "uniq",
  "cut",
  "tr",
  "tee",
  "xargs",
  "jq",
  "yq",
  "http",
  "dig",
  "nslookup",
  "ping",
  "tree",
  "du",
  "df",
]);

// ── HIGH_RISK_PROGRAMS from checker.ts ───────────────────────────────────────
const HIGH_RISK_PROGRAMS = new Set([
  "sudo",
  "su",
  "doas",
  "dd",
  "mkfs",
  "fdisk",
  "parted",
  "mount",
  "umount",
  "systemctl",
  "service",
  "launchctl",
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "groupdel",
  "iptables",
  "ufw",
  "firewall-cmd",
  "reboot",
  "shutdown",
  "halt",
  "poweroff",
  "kill",
  "killall",
  "pkill",
]);

// ── WRAPPER_PROGRAMS from checker.ts ─────────────────────────────────────────
const WRAPPER_PROGRAMS = new Set([
  "env",
  "nice",
  "nohup",
  "time",
  "command",
  "exec",
  "strace",
  "ltrace",
  "ionice",
  "taskset",
  "timeout",
]);

// ── LOW_RISK_GIT_SUBCOMMANDS from checker.ts ─────────────────────────────────
const LOW_RISK_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "tag",
  "remote",
  "stash",
  "blame",
  "shortlog",
  "describe",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "reflog",
]);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("command-registry", () => {
  describe("structure validation", () => {
    test("every entry has a valid baseRisk", () => {
      const validRisks = new Set(["low", "medium", "high"]);
      for (const [_name, spec] of Object.entries(DEFAULT_COMMAND_REGISTRY)) {
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
          duplicates.push(
            `"${id}" appears in both "${seen.get(id)}" and "${path}"`,
          );
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
      for (const [_name, spec] of Object.entries(DEFAULT_COMMAND_REGISTRY)) {
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
        const spec = (
          DEFAULT_COMMAND_REGISTRY as Record<string, CommandRiskSpec>
        )[prog];
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
      const subs = gitSpec.subcommands! as Record<string, unknown>;
      for (const sub of LOW_RISK_GIT_SUBCOMMANDS) {
        if (!subs[sub]) {
          missing.push(sub);
        }
      }
      expect(missing).toEqual([]);
    });

    test("every program in HIGH_RISK_PROGRAMS has baseRisk high in the registry", () => {
      const errors: string[] = [];
      for (const prog of HIGH_RISK_PROGRAMS) {
        const spec = (
          DEFAULT_COMMAND_REGISTRY as Record<string, CommandRiskSpec>
        )[prog];
        if (!spec) {
          errors.push(`${prog}: missing from registry`);
        } else if (spec.baseRisk !== "high") {
          errors.push(
            `${prog}: expected baseRisk "high", got "${spec.baseRisk}"`,
          );
        }
      }
      expect(errors).toEqual([]);
    });

    test("every LOW_RISK_GIT_SUBCOMMAND has baseRisk low in the registry", () => {
      const gitSpec = DEFAULT_COMMAND_REGISTRY.git;
      const errors: string[] = [];

      const gitSubs = gitSpec.subcommands! as Record<string, CommandRiskSpec>;
      for (const sub of LOW_RISK_GIT_SUBCOMMANDS) {
        const subSpec = gitSubs[sub];
        if (subSpec && subSpec.baseRisk !== "low") {
          // stash is an exception — its baseRisk is "medium" (write operation)
          // but it was in LOW_RISK_GIT_SUBCOMMANDS because `git stash` without
          // args defaults to `git stash push`, and the checker treated the bare
          // command as low. Our registry has it as medium with low subcommands.
          if (sub === "stash") continue;
          errors.push(
            `git ${sub}: expected baseRisk "low", got "${subSpec.baseRisk}"`,
          );
        }
      }

      expect(errors).toEqual([]);
    });
  });

  describe("command and exec special cases", () => {
    test("command has isWrapper: true and argRule for -v/-V lookup", () => {
      const spec = DEFAULT_COMMAND_REGISTRY.command;
      expect(spec.isWrapper).toBe(true);
      expect(spec.baseRisk).toBe("low");
      expect(spec.argRules).toBeDefined();

      const lookupRule = spec.argRules!.find((r) => r.id === "command:lookup");
      expect(lookupRule).toBeDefined();
      expect(lookupRule!.flags).toContain("-v");
      expect(lookupRule!.flags).toContain("-V");
      expect(lookupRule!.risk).toBe("low");
    });

    test("exec is high risk wrapper (replaces current shell process)", () => {
      const spec = DEFAULT_COMMAND_REGISTRY.exec;
      expect(spec.baseRisk).toBe("high");
      expect(spec.isWrapper).toBe(true);
      expect(spec.reason).toBe("Replaces current shell process");
    });
  });

  describe("registry entry count", () => {
    test("has at least 90 entries (comprehensive coverage)", () => {
      const count = Object.keys(DEFAULT_COMMAND_REGISTRY).length;
      expect(count).toBeGreaterThanOrEqual(90);
    });
  });

  // ── assistant CLI subcommand risk levels ─────────────────────────────────
  // Keep this in sync with assistant/src/cli/commands and with
  // gateway/src/risk/command-registry/commands/assistant.ts.
  describe("assistant subcommand classifications", () => {
    const assistantSpec = DEFAULT_COMMAND_REGISTRY.assistant;
    const assistantSubs = assistantSpec.subcommands!;

    function getAssistantPath(path: string): CommandRiskSpec {
      const segments = path.split(" ").filter((segment) => segment.length > 0);
      let current: CommandRiskSpec = assistantSpec;
      for (const segment of segments) {
        const next = current.subcommands?.[segment];
        expect(next).toBeDefined();
        current = next!;
      }
      return current;
    }

    test("assistant (bare) is low risk", () => {
      expect(assistantSpec.baseRisk).toBe("low");
    });

    // ── oauth subcommand ──────────────────────────────────────────────────
    describe("oauth", () => {
      const oauthSpec = assistantSubs.oauth;

      test("assistant oauth (bare) is low risk", () => {
        expect(oauthSpec.baseRisk).toBe("low");
      });

      test("assistant oauth token is high risk", () => {
        expect(oauthSpec.subcommands!.token.baseRisk).toBe("high");
      });

      test("assistant oauth mode (bare) is low risk", () => {
        expect(oauthSpec.subcommands!.mode.baseRisk).toBe("low");
      });

      test("assistant oauth mode has --set argRule escalating to high", () => {
        const modeSpec = oauthSpec.subcommands!.mode;
        expect(modeSpec.argRules).toBeDefined();
        const setRule = modeSpec.argRules!.find((r) =>
          r.flags?.includes("--set"),
        );
        expect(setRule).toBeDefined();
        expect(setRule!.risk).toBe("high");
      });

      test("assistant oauth request is medium risk", () => {
        expect(oauthSpec.subcommands!.request.baseRisk).toBe("medium");
      });

      test("assistant oauth connect is low risk", () => {
        expect(oauthSpec.subcommands!.connect.baseRisk).toBe("low");
      });

      test("assistant oauth disconnect is medium risk", () => {
        expect(oauthSpec.subcommands!.disconnect.baseRisk).toBe("medium");
      });
    });

    // ── credentials subcommand ────────────────────────────────────────────
    describe("credentials", () => {
      const credSpec = assistantSubs.credentials;

      test("assistant credentials (bare) is low risk", () => {
        expect(credSpec.baseRisk).toBe("low");
      });

      test("assistant credentials reveal is high risk", () => {
        expect(credSpec.subcommands!.reveal.baseRisk).toBe("high");
      });

      test("assistant credentials set is high risk", () => {
        expect(credSpec.subcommands!.set.baseRisk).toBe("high");
      });

      test("assistant credentials delete is high risk", () => {
        expect(credSpec.subcommands!.delete.baseRisk).toBe("high");
      });
    });

    // ── keys subcommand ───────────────────────────────────────────────────
    describe("keys", () => {
      const keysSpec = assistantSubs.keys;

      test("assistant keys (bare) is low risk", () => {
        expect(keysSpec.baseRisk).toBe("low");
      });

      test("assistant keys set is high risk", () => {
        expect(keysSpec.subcommands!.set.baseRisk).toBe("high");
      });

      test("assistant keys delete is high risk", () => {
        expect(keysSpec.subcommands!.delete.baseRisk).toBe("high");
      });
    });

    // ── trust subcommand ──────────────────────────────────────────────────
    describe("trust", () => {
      const trustSpec = assistantSubs.trust;

      test("assistant trust (bare) is low risk", () => {
        expect(trustSpec.baseRisk).toBe("low");
      });
    });

    // ── low-risk subcommands (no further subcommands) ────────────────────
    describe("simple low-risk subcommands", () => {
      test("assistant platform is low risk", () => {
        expect(assistantSubs.platform.baseRisk).toBe("low");
      });

      test("assistant backup is low risk", () => {
        expect(assistantSubs.backup.baseRisk).toBe("low");
      });

      test("assistant help is low risk", () => {
        expect(assistantSubs.help.baseRisk).toBe("low");
      });
    });

    // ── completeness check ────────────────────────────────────────────────
    test("legacy elevated assistant subcommand groups are present", () => {
      const requiredSubcommands = ["oauth", "credentials", "keys", "trust"];
      const actualSubcommands = Object.keys(assistantSubs);
      for (const sub of requiredSubcommands) {
        expect(actualSubcommands).toContain(sub);
      }
    });

    test("oauth has all expected sub-subcommands", () => {
      const oauthSubs = Object.keys(
        assistantSpec.subcommands!.oauth.subcommands!,
      );
      expect(oauthSubs).toContain("token");
      expect(oauthSubs).toContain("mode");
      expect(oauthSubs).toContain("request");
      expect(oauthSubs).toContain("connect");
      expect(oauthSubs).toContain("disconnect");
    });

    test("credentials has all expected sub-subcommands", () => {
      const credSubs = Object.keys(
        assistantSpec.subcommands!.credentials.subcommands!,
      );
      expect(credSubs).toContain("reveal");
      expect(credSubs).toContain("set");
      expect(credSubs).toContain("delete");
    });

    test("keys has all expected sub-subcommands", () => {
      const keysSubs = Object.keys(
        assistantSpec.subcommands!.keys.subcommands!,
      );
      expect(keysSubs).toContain("set");
      expect(keysSubs).toContain("delete");
    });

    test("trust has all expected sub-subcommands", () => {
      const trustSubs = Object.keys(
        assistantSpec.subcommands!.trust.subcommands!,
      );
      expect(trustSubs).toContain("list");
    });

    test("covers expanded top-level assistant command groups", () => {
      const requiredTopLevel = [
        "attachment",
        "audit",
        "auth",
        "autonomy",
        "avatar",
        "backup",
        "bash",
        "browser",
        "cache",
        "channel-verification-sessions",
        "clients",
        "completions",
        "config",
        "contacts",
        "conversations",
        "credential-execution",
        "credentials",
        "domain",
        "email",
        "image-generation",
        "inference",
        "llm",
        "keys",
        "mcp",
        "memory",
        "notifications",
        "oauth",
        "platform",
        "routes",
        "sequence",
        "skills",
        "stt",
        "task",
        "trust",
        "tts",
        "ui",
        "usage",
        "watchers",
        "webhooks",
      ];
      const actual = Object.keys(assistantSubs);
      for (const sub of requiredTopLevel) {
        expect(actual).toContain(sub);
      }
    });

    test("expanded assistant operations have expected risk levels", () => {
      expect(getAssistantPath("config set").baseRisk).toBe("low");
      expect(getAssistantPath("oauth providers register").baseRisk).toBe(
        "medium",
      );
      expect(getAssistantPath("email send").baseRisk).toBe("high");
      expect(getAssistantPath("domain register").baseRisk).toBe("medium");
      expect(getAssistantPath("conversations clear").baseRisk).toBe("medium");
      expect(getAssistantPath("conversations wipe").baseRisk).toBe("high");
      expect(getAssistantPath("backup restore").baseRisk).toBe("high");
      expect(getAssistantPath("inference profile open").baseRisk).toBe("low");
      expect(getAssistantPath("inference profile close").baseRisk).toBe("low");
      expect(getAssistantPath("inference profile list").baseRisk).toBe("low");
    });
  });

  // ── sandboxAutoApprove allowlist guard ───────────────────────────────────
  describe("sandboxAutoApprove allowlist", () => {
    /** Collect all top-level commands tagged with sandboxAutoApprove: true. */
    function getSandboxAutoApproveCommands(): string[] {
      return Object.entries(DEFAULT_COMMAND_REGISTRY)
        .filter(
          ([, spec]) => (spec as CommandRiskSpec).sandboxAutoApprove === true,
        )
        .map(([name]) => name)
        .sort();
    }

    /**
     * The exact set of commands that should be tagged with sandboxAutoApprove.
     * This acts as a guard — any addition or removal must be intentional and
     * update this list.
     */
    const EXPECTED_SANDBOX_AUTO_APPROVE = [
      // Core filesystem (read-only)
      "ls",
      "cat",
      "head",
      "tail",
      "less",
      "more",
      "wc",
      "file",
      "stat",
      "du",
      "df",
      "diff",
      "tree",
      "pwd",
      "realpath",
      "basename",
      "dirname",
      "readlink",
      // Search / filter / text processing
      "grep",
      "rg",
      "ag",
      "ack",
      "sort",
      "uniq",
      "cut",
      "tr",
      "sed",
      // awk excluded: system() can execute arbitrary commands
      // System info / text output
      "echo",
      "printf",
      // Data processing
      "jq",
      "yq",
      // find excluded: -exec/-execdir/-delete can execute arbitrary commands or delete files
      "fd",
      // Write commands
      "cp",
      "mv",
      "mkdir",
      "touch",
      "ln",
      "tee",
      // Delete commands
      "rm",
      "rmdir",
      // Permissions / ownership
      "chgrp",
      "chmod",
      "chown",
      // Archives
      "tar",
      "zip",
      "unzip",
      "gzip",
      "gunzip",
    ].sort();

    test("sandboxAutoApprove commands match the expected allowlist exactly", () => {
      const actual = getSandboxAutoApproveCommands();
      expect(actual).toEqual(EXPECTED_SANDBOX_AUTO_APPROVE);
    });

    test("network commands are NOT tagged with sandboxAutoApprove", () => {
      const networkCommands = [
        "curl",
        "wget",
        "http",
        "ssh",
        "scp",
        "rsync",
        "ping",
        "dig",
        "nslookup",
      ];
      for (const cmd of networkCommands) {
        const spec = (
          DEFAULT_COMMAND_REGISTRY as Record<string, CommandRiskSpec>
        )[cmd];
        expect(spec).toBeDefined();
        expect(spec.sandboxAutoApprove).not.toBe(true);
      }
    });

    test("runtime/language commands are NOT tagged with sandboxAutoApprove", () => {
      const runtimeCommands = [
        "node",
        "deno",
        "python",
        "python3",
        "ruby",
        "bash",
        "sh",
        "zsh",
      ];
      for (const cmd of runtimeCommands) {
        const spec = (
          DEFAULT_COMMAND_REGISTRY as Record<string, CommandRiskSpec>
        )[cmd];
        expect(spec).toBeDefined();
        expect(spec.sandboxAutoApprove).not.toBe(true);
      }
    });

    test("package manager commands are NOT tagged with sandboxAutoApprove", () => {
      const packageCommands = [
        "npm",
        "npx",
        "yarn",
        "pnpm",
        "bun",
        "pip",
        "pip3",
        "brew",
        "cargo",
        "apt-get",
        "apt",
        "dnf",
        "yum",
        "pacman",
        "apk",
      ];
      for (const cmd of packageCommands) {
        const spec = (
          DEFAULT_COMMAND_REGISTRY as Record<string, CommandRiskSpec>
        )[cmd];
        expect(spec).toBeDefined();
        expect(spec.sandboxAutoApprove).not.toBe(true);
      }
    });

    test("every sandboxAutoApprove command must have argSchema defined", () => {
      const missing: string[] = [];
      for (const [name, spec] of Object.entries(DEFAULT_COMMAND_REGISTRY)) {
        if (
          (spec as CommandRiskSpec).sandboxAutoApprove === true &&
          (spec as CommandRiskSpec).argSchema === undefined
        ) {
          missing.push(name);
        }
      }
      expect(missing).toEqual([]);
    });

    test("xargs is NOT tagged with sandboxAutoApprove", () => {
      const spec = (DEFAULT_COMMAND_REGISTRY as Record<string, CommandRiskSpec>)
        .xargs;
      expect(spec).toBeDefined();
      expect(spec.sandboxAutoApprove).not.toBe(true);
    });

    test("commands with value-consuming argRule flags have matching argSchema.valueFlags", () => {
      // When an argRule has both `flags` and `valuePattern`, those flags consume
      // the next token as a value — the valuePattern matches against that value.
      // The command's argSchema.valueFlags must include those flags so that
      // parseArgs() correctly pairs flags with their values.
      const errors: string[] = [];

      function checkSpec(spec: CommandRiskSpec, path: string): void {
        if (spec.argRules) {
          for (const rule of spec.argRules) {
            if (rule.flags && rule.valuePattern) {
              // This rule's flags consume a value — check argSchema coverage.
              const schemaValueFlags = new Set(
                spec.argSchema?.valueFlags ?? [],
              );
              for (const flag of rule.flags) {
                if (!schemaValueFlags.has(flag)) {
                  errors.push(
                    `${path}/${rule.id}: flag "${flag}" consumes a value (has valuePattern) ` +
                      `but is not listed in argSchema.valueFlags`,
                  );
                }
              }
            }
          }
        }
        if (spec.subcommands) {
          for (const [sub, subSpec] of Object.entries(spec.subcommands)) {
            checkSpec(subSpec, `${path} ${sub}`);
          }
        }
      }

      for (const [name, spec] of Object.entries(DEFAULT_COMMAND_REGISTRY)) {
        checkSpec(spec as CommandRiskSpec, name);
      }
      expect(errors).toEqual([]);
    });

    test("system/privilege commands are NOT tagged with sandboxAutoApprove", () => {
      const systemCommands = [
        "sudo",
        "su",
        "doas",
        "mount",
        "umount",
        "systemctl",
        "service",
        "launchctl",
        "reboot",
        "shutdown",
        "kill",
        "killall",
        "pkill",
        "dd",
        "mkfs",
        "fdisk",
      ];
      for (const cmd of systemCommands) {
        const spec = (
          DEFAULT_COMMAND_REGISTRY as Record<string, CommandRiskSpec>
        )[cmd];
        expect(spec).toBeDefined();
        expect(spec.sandboxAutoApprove).not.toBe(true);
      }
    });
  });

  // ── filesystemOp tagging ─────────────────────────────────────────────────
  describe("filesystemOp tagging", () => {
    /** Collect all top-level commands tagged with filesystemOp: true. */
    function getFilesystemOpCommands(): string[] {
      return Object.entries(DEFAULT_COMMAND_REGISTRY)
        .filter(([, spec]) => (spec as CommandRiskSpec).filesystemOp === true)
        .map(([name]) => name)
        .sort();
    }

    test("has at least 30 entries tagged with filesystemOp (design-doc inventory)", () => {
      const tagged = getFilesystemOpCommands();
      expect(tagged.length).toBeGreaterThanOrEqual(30);
    });

    test("representative filesystem commands are tagged with filesystemOp", () => {
      const expectedTagged = ["ls", "cat", "grep", "rm", "cp", "tar"];
      const missing: string[] = [];
      for (const cmd of expectedTagged) {
        const spec = (
          DEFAULT_COMMAND_REGISTRY as Record<string, CommandRiskSpec>
        )[cmd];
        if (!spec) {
          missing.push(`${cmd}: missing from registry`);
        } else if (spec.filesystemOp !== true) {
          missing.push(`${cmd}: filesystemOp is not true`);
        }
      }
      expect(missing).toEqual([]);
    });

    test("non-filesystem commands are NOT tagged with filesystemOp", () => {
      const expectedNotTagged = [
        "echo",
        "curl",
        "git",
        "npm",
        "node",
        "python",
      ];
      const errors: string[] = [];
      for (const cmd of expectedNotTagged) {
        const spec = (
          DEFAULT_COMMAND_REGISTRY as Record<string, CommandRiskSpec>
        )[cmd];
        if (!spec) {
          errors.push(`${cmd}: missing from registry`);
        } else if (spec.filesystemOp === true) {
          errors.push(`${cmd}: filesystemOp should not be true`);
        }
      }
      expect(errors).toEqual([]);
    });
  });
});
