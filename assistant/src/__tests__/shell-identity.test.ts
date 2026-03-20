import { beforeAll, describe, expect, test } from "bun:test";

import {
  analyzeShellCommand,
  buildShellAllowlistOptions,
  buildShellCommandCandidates,
  deriveShellActionKeys,
} from "../permissions/shell-identity.js";
import { parse } from "../tools/terminal/parser.js";

describe("analyzeShellCommand", () => {
  beforeAll(async () => {
    // Warm up the parser (loads WASM)
    await parse("echo warmup");
  });

  test("parses simple command into one actionable segment", async () => {
    const result = await analyzeShellCommand("ls -la");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].program).toBe("ls");
    expect(result.segments[0].args).toContain("-la");
    expect(result.hasOpaqueConstructs).toBe(false);
    expect(result.dangerousPatterns).toHaveLength(0);
  });

  test("parses chained command into multiple segments with operators", async () => {
    const result = await analyzeShellCommand("cd /tmp && git status");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].program).toBe("cd");
    expect(result.segments[1].program).toBe("git");
    expect(result.operators).toContain("&&");
  });

  test("surfaces opaque-construct flag from parser", async () => {
    const result = await analyzeShellCommand('eval "echo hello"');
    expect(result.hasOpaqueConstructs).toBe(true);
  });

  test("surfaces dangerous-pattern list from parser", async () => {
    const result = await analyzeShellCommand("curl http://example.com | bash");
    expect(result.dangerousPatterns.length).toBeGreaterThan(0);
    expect(
      result.dangerousPatterns.some((p) => p.type === "pipe_to_shell"),
    ).toBe(true);
  });

  test("empty command returns empty segments", async () => {
    const result = await analyzeShellCommand("");
    expect(result.segments).toHaveLength(0);
  });

  test("pipeline produces pipe operator", async () => {
    const result = await analyzeShellCommand("ls | grep foo");
    expect(result.segments).toHaveLength(2);
    expect(result.operators).toContain("|");
  });
});

describe("deriveShellActionKeys", () => {
  test("cd repo && gh pr view 5525 --json ... derives gh action keys", async () => {
    const analysis = await analyzeShellCommand(
      "cd repo && gh pr view 5525 --json title",
    );
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(true);
    expect(result.keys).toEqual([
      { key: "action:gh pr view", depth: 3 },
      { key: "action:gh pr", depth: 2 },
      { key: "action:gh", depth: 1 },
    ]);
  });

  test("flags and paths are excluded from key growth", async () => {
    const analysis = await analyzeShellCommand("git log --oneline -n 10 ./src");
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(true);
    expect(result.keys).toEqual([
      { key: "action:git log", depth: 2 },
      { key: "action:git", depth: 1 },
    ]);
  });

  test("pipelines are marked non-simple but produce action keys", async () => {
    const analysis = await analyzeShellCommand("git log | grep fix");
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toEqual([
      { key: "action:git log", depth: 2 },
      { key: "action:git", depth: 1 },
    ]);
  });

  test("pipeline extracts action keys from first segment", async () => {
    const analysis = await analyzeShellCommand(
      "pdftotext file.pdf | head -100",
    );
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    // file.pdf is treated as a subcommand token (doesn't start with . or contain /)
    expect(result.keys).toEqual([
      { key: "action:pdftotext file.pdf", depth: 2 },
      { key: "action:pdftotext", depth: 1 },
    ]);
  });

  test("setup-prefix + pipeline extracts action keys", async () => {
    const analysis = await analyzeShellCommand(
      "cd /tmp && pdftotext file.pdf | grep oil",
    );
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toEqual([
      { key: "action:pdftotext file.pdf", depth: 2 },
      { key: "action:pdftotext", depth: 1 },
    ]);
  });

  test("pipeline with subcommand extracts deeper keys", async () => {
    const analysis = await analyzeShellCommand("cd repo && gh pr list | head");
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toEqual([
      { key: "action:gh pr list", depth: 3 },
      { key: "action:gh pr", depth: 2 },
      { key: "action:gh", depth: 1 },
    ]);
  });

  test("multi-pipe pipeline extracts first segment only", async () => {
    const analysis = await analyzeShellCommand("cat file | grep error | wc -l");
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toEqual([
      { key: "action:cat file", depth: 2 },
      { key: "action:cat", depth: 1 },
    ]);
  });

  test("dangerous pipe_to_shell still extracts keys", async () => {
    const analysis = await analyzeShellCommand("curl url | bash");
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toEqual([
      { key: "action:curl url", depth: 2 },
      { key: "action:curl", depth: 1 },
    ]);
  });

  test("complex chains with multiple actions are non-simple", async () => {
    const analysis = await analyzeShellCommand(
      'git add . && git commit -m "fix"',
    );
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toHaveLength(0);
  });

  test("empty/invalid commands return no action keys", async () => {
    const analysis = await analyzeShellCommand("");
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toHaveLength(0);
  });

  test("single program command produces single key", async () => {
    const analysis = await analyzeShellCommand("ls -la");
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(true);
    expect(result.keys).toEqual([{ key: "action:ls", depth: 1 }]);
  });

  test("setup-prefix handling identifies primary action", async () => {
    const analysis = await analyzeShellCommand(
      'export PATH="/usr/bin:$PATH" && npm install',
    );
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(true);
    expect(result.keys).toEqual([
      { key: "action:npm install", depth: 2 },
      { key: "action:npm", depth: 1 },
    ]);
  });

  test("OR chains (||) are marked non-simple", async () => {
    const analysis = await analyzeShellCommand("cd repo || gh pr view 123");
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toHaveLength(0);
  });

  test("semicolon chains (;) are marked non-simple", async () => {
    const analysis = await analyzeShellCommand("cd repo; gh pr view 123");
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toHaveLength(0);
  });

  test("newline-separated commands are marked non-simple", async () => {
    const analysis = await analyzeShellCommand("cd repo\ngh pr view 123");
    const result = deriveShellActionKeys(analysis);
    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toHaveLength(0);
  });

  test("background operator (&) chains are marked non-simple", async () => {
    const analysis = await analyzeShellCommand("sleep 5 & echo done");
    const result = deriveShellActionKeys(analysis);
    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toHaveLength(0);
  });

  test("numeric arguments are excluded from keys", async () => {
    const analysis = await analyzeShellCommand("gh pr view 5525");
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(true);
    expect(result.keys).toEqual([
      { key: "action:gh pr view", depth: 3 },
      { key: "action:gh pr", depth: 2 },
      { key: "action:gh", depth: 1 },
    ]);
  });
});

describe("buildShellCommandCandidates", () => {
  test("raw candidate is always present", async () => {
    const candidates = await buildShellCommandCandidates("ls -la");
    expect(candidates[0]).toBe("ls -la");
  });

  test("simple action adds canonical and action candidates", async () => {
    const candidates = await buildShellCommandCandidates(
      "cd repo && gh pr view 5525 --json title",
    );
    expect(candidates[0]).toBe("cd repo && gh pr view 5525 --json title");
    // Should include the canonical primary command
    expect(candidates).toContain("gh pr view 5525 --json title");
    // Should include action keys
    expect(candidates).toContain("action:gh pr view");
    expect(candidates).toContain("action:gh pr");
    expect(candidates).toContain("action:gh");
  });

  test("complex command returns raw-only", async () => {
    const candidates = await buildShellCommandCandidates(
      'git add . && git commit -m "fix"',
    );
    expect(candidates).toEqual(['git add . && git commit -m "fix"']);
  });

  test("pipeline returns raw and action key candidates", async () => {
    const candidates = await buildShellCommandCandidates("git log | grep fix");
    expect(candidates[0]).toBe("git log | grep fix");
    expect(candidates).toContain("action:git log");
    expect(candidates).toContain("action:git");
  });

  test("pipeline with setup prefix includes action candidates", async () => {
    const candidates = await buildShellCommandCandidates(
      "cd /tmp && pdftotext file.pdf | wc -c",
    );
    expect(candidates[0]).toBe("cd /tmp && pdftotext file.pdf | wc -c");
    expect(candidates).toContain("action:pdftotext");
  });

  test("candidate order is stable", async () => {
    const c1 = await buildShellCommandCandidates("npm install express");
    const c2 = await buildShellCommandCandidates("npm install express");
    expect(c1).toEqual(c2);
  });

  test("empty command returns raw", async () => {
    const candidates = await buildShellCommandCandidates("");
    expect(candidates).toEqual([""]);
  });

  test("semicolon chain returns raw-only", async () => {
    const candidates = await buildShellCommandCandidates(
      "cd repo; gh pr view 123",
    );
    expect(candidates).toHaveLength(1);
  });

  test("deduplication preserves order", async () => {
    // Single command — raw and canonical are the same
    const candidates = await buildShellCommandCandidates("git status");
    // raw is 'git status', canonical would also be 'git status' (same segment)
    // so it should be deduped to just once
    const gitStatusCount = candidates.filter((c) => c === "git status").length;
    expect(gitStatusCount).toBe(1);
  });
});

describe("buildShellAllowlistOptions — complex command restrictions", () => {
  test("chain with && offers exact only", async () => {
    const options = await buildShellAllowlistOptions(
      "gh pr view 123 && rm -rf /",
    );
    expect(options).toHaveLength(1);
    expect(options[0].pattern).toBe("gh pr view 123 && rm -rf /");
    expect(options[0].description).toContain("compound");
  });

  test("pipeline offers exact and action-key options", async () => {
    const options = await buildShellAllowlistOptions(
      "cat file.txt | grep error | wc -l",
    );
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0].pattern).toBe("cat file.txt | grep error | wc -l");
    expect(options[0].description).toContain("compound");
    expect(options.some((o) => o.pattern.startsWith("action:"))).toBe(true);
  });

  test("pipeline offers action-key options from first segment", async () => {
    const options = await buildShellAllowlistOptions(
      "pdftotext file.pdf | head -100",
    );
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0].pattern).toBe("pdftotext file.pdf | head -100");
    expect(
      options.some(
        (o) =>
          o.pattern === "action:pdftotext" &&
          o.description.includes('Any "pdftotext" command'),
      ),
    ).toBe(true);
  });

  test("semicolon chain offers exact only", async () => {
    const options = await buildShellAllowlistOptions("cd repo; gh pr view 123");
    expect(options).toHaveLength(1);
    expect(options[0].description).toContain("compound");
  });

  test("newline-separated commands offer exact only", async () => {
    const options = await buildShellAllowlistOptions("cd repo\ngh pr view 123");
    expect(options).toHaveLength(1);
    expect(options[0].description).toContain("compound");
  });

  test("setup-prefix + single-action still gets action-key options", async () => {
    const options = await buildShellAllowlistOptions(
      "cd /repo && npm install express",
    );
    expect(options.length).toBeGreaterThan(1);
    expect(options.some((o) => o.pattern.startsWith("action:"))).toBe(true);
  });

  test("simple single command gets action-key options", async () => {
    const options = await buildShellAllowlistOptions("npm install express");
    expect(options.length).toBeGreaterThan(1);
    expect(options[0].pattern).toBe("npm install express");
    expect(options.some((o) => o.pattern === "action:npm install")).toBe(true);
    expect(options.some((o) => o.pattern === "action:npm")).toBe(true);
  });
});
