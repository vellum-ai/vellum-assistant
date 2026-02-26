import { describe, test, expect, beforeEach, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsshCliPath = join(
  __dirname,
  "..",
  "..",
  "..",
  "assistant",
  "src",
  "skills",
  "skillssh-cli.ts",
);

describe("vellum skills CLI", () => {
  test("skillssh-cli.ts exists at the expected path", () => {
    expect(existsSync(skillsshCliPath)).toBe(true);
  });

  describe("runSkillsshCli", () => {
    // We test the exported function directly by importing the module
    let runSkillsshCli: (subArgs: string[]) => number;

    beforeEach(async () => {
      const mod = await import("../commands/skills.js");
      runSkillsshCli = mod.runSkillsshCli;
    });

    test("is a function", () => {
      expect(typeof runSkillsshCli).toBe("function");
    });
  });

  describe("search subcommand routing", () => {
    test("search with no query shows usage and exits with non-zero", () => {
      const result = spawnSync(
        "bun",
        ["run", join(__dirname, "..", "index.ts"), "skills", "search"],
        { encoding: "utf-8", timeout: 10000 },
      );
      expect(result.stderr).toContain("Usage:");
      expect(result.status).not.toBe(0);
    });
  });

  describe("evaluate subcommand routing", () => {
    test("evaluate with insufficient args shows usage and exits with non-zero", () => {
      const result = spawnSync(
        "bun",
        ["run", join(__dirname, "..", "index.ts"), "skills", "evaluate", "only-one-arg"],
        { encoding: "utf-8", timeout: 10000 },
      );
      expect(result.stderr).toContain("Usage:");
      expect(result.status).not.toBe(0);
    });
  });

  describe("install subcommand routing", () => {
    test("install with no args shows usage and exits with non-zero", () => {
      const result = spawnSync(
        "bun",
        ["run", join(__dirname, "..", "index.ts"), "skills", "install"],
        { encoding: "utf-8", timeout: 10000 },
      );
      expect(result.stderr).toContain("Usage:");
      expect(result.status).not.toBe(0);
    });
  });

  describe("list subcommand", () => {
    test("list subcommand is still recognized (does not error as unknown)", () => {
      // We can't test the full flow without network, but we can verify
      // it doesn't fall through to "Unknown skills subcommand"
      const result = spawnSync(
        "bun",
        ["run", join(__dirname, "..", "index.ts"), "skills", "list", "--json"],
        { encoding: "utf-8", timeout: 15000 },
      );
      // It will either succeed with JSON or fail with a platform API error,
      // but it should not say "Unknown skills subcommand"
      const combined = (result.stdout ?? "") + (result.stderr ?? "");
      expect(combined).not.toContain("Unknown skills subcommand");
    });
  });

  describe("unknown subcommand", () => {
    test("unknown subcommand errors", () => {
      const result = spawnSync(
        "bun",
        ["run", join(__dirname, "..", "index.ts"), "skills", "bogus"],
        { encoding: "utf-8", timeout: 10000 },
      );
      expect(result.stderr).toContain("Unknown skills subcommand");
      expect(result.status).not.toBe(0);
    });
  });

  describe("help output", () => {
    test("--help shows all subcommands including search and evaluate", () => {
      const result = spawnSync(
        "bun",
        ["run", join(__dirname, "..", "index.ts"), "skills", "--help"],
        { encoding: "utf-8", timeout: 10000 },
      );
      const output = result.stdout ?? "";
      expect(output).toContain("search");
      expect(output).toContain("evaluate");
      expect(output).toContain("install");
      expect(output).toContain("list");
    });
  });
});
