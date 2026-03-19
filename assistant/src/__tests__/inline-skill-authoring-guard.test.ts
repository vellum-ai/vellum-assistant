import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { parseFrontmatterFields } from "../skills/frontmatter.js";
import { parseInlineCommandExpansions } from "../skills/inline-command-expansions.js";

/**
 * Guard test: scan bundled and first-party skills for malformed inline
 * command expansion syntax (`!\`...\``).
 *
 * This guard ensures that:
 * 1. No skill ships with malformed inline expansion tokens (empty commands,
 *    unmatched backticks, nested backticks) that would be rejected by the
 *    parser at runtime.
 * 2. Fenced-code examples containing `!\`...\`` syntax are correctly
 *    ignored by the parser and not treated as live commands — verified by
 *    fixture coverage below.
 *
 * See assistant/docs/skills.md "Inline Command Expansions" for the full
 * syntax specification and security model.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

function getBundledSkillsDir(): string {
  return join(process.cwd(), "src", "config", "bundled-skills");
}

function getFirstPartySkillsDir(): string {
  return join(getRepoRoot(), "skills");
}

/**
 * Discover all SKILL.md files under a given directory (one level deep).
 * Returns an array of { id, skillFilePath } entries.
 */
function discoverSkillFiles(
  dir: string,
): Array<{ id: string; skillFilePath: string }> {
  if (!existsSync(dir)) return [];

  const results: Array<{ id: string; skillFilePath: string }> = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFilePath = join(dir, entry.name, "SKILL.md");
    if (existsSync(skillFilePath) && statSync(skillFilePath).isFile()) {
      results.push({ id: entry.name, skillFilePath });
    }
  }

  return results.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Extract the markdown body from a SKILL.md file (strip frontmatter).
 * Returns the body text, or null if the file has no valid frontmatter.
 */
function extractBody(filePath: string): string | undefined {
  const content = readFileSync(filePath, "utf-8");
  const result = parseFrontmatterFields(content);
  return result?.body;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("inline skill authoring guard", () => {
  test("bundled skills contain no malformed inline command expansion tokens", () => {
    const bundledDir = getBundledSkillsDir();
    const skills = discoverSkillFiles(bundledDir);

    const violations: string[] = [];

    for (const { id, skillFilePath } of skills) {
      const body = extractBody(skillFilePath);
      if (body === undefined) continue;

      const result = parseInlineCommandExpansions(body);
      if (result.errors.length > 0) {
        for (const error of result.errors) {
          violations.push(
            `bundled/${id}: ${error.reason} at offset ${error.offset} — ${JSON.stringify(error.raw)}`,
          );
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        "Found bundled skills with malformed inline command expansion tokens.",
        "Fix the syntax or move examples inside fenced code blocks.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  test("first-party skills contain no malformed inline command expansion tokens", () => {
    const firstPartyDir = getFirstPartySkillsDir();
    const skills = discoverSkillFiles(firstPartyDir);

    const violations: string[] = [];

    for (const { id, skillFilePath } of skills) {
      const body = extractBody(skillFilePath);
      if (body === undefined) continue;

      const result = parseInlineCommandExpansions(body);
      if (result.errors.length > 0) {
        for (const error of result.errors) {
          violations.push(
            `skills/${id}: ${error.reason} at offset ${error.offset} — ${JSON.stringify(error.raw)}`,
          );
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        "Found first-party skills with malformed inline command expansion tokens.",
        "Fix the syntax or move examples inside fenced code blocks.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  test("fenced-code examples containing inline expansion syntax are not treated as live commands", () => {
    // This fixture verifies the parser's fenced-code-block exclusion logic.
    // Skills that document the `!\`command\`` syntax in fenced code blocks
    // must not have those examples picked up as live expansions.
    const fixture = [
      "# Example Skill",
      "",
      "Use inline commands to inject dynamic context:",
      "",
      "```markdown",
      "Current branch: !`git branch --show-current`",
      "Recent commits: !`git log --oneline -5`",
      "```",
      "",
      "~~~",
      "!`echo hello`",
      "~~~",
      "",
      "````",
      "```",
      "!`nested example`",
      "```",
      "````",
      "",
      "The above examples are documentation only and should not execute.",
    ].join("\n");

    const result = parseInlineCommandExpansions(fixture);

    expect(result.expansions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("skills docs file itself contains no accidentally live inline expansion tokens", () => {
    // The skills.md documentation describes the `!\`command\`` syntax
    // extensively. Verify that all examples are inside fenced code blocks
    // and the parser does not detect any live or malformed tokens.
    const docsPath = join(process.cwd(), "docs", "skills.md");
    if (!existsSync(docsPath)) {
      // Skip if the docs file doesn't exist (should not happen in normal checkout)
      return;
    }

    const content = readFileSync(docsPath, "utf-8");
    const result = parseInlineCommandExpansions(content);

    if (result.errors.length > 0) {
      const message = [
        "assistant/docs/skills.md contains malformed inline command expansion tokens.",
        "Ensure all examples are inside fenced code blocks.",
        "",
        "Errors:",
        ...result.errors.map(
          (e) =>
            `  - ${e.reason} at offset ${e.offset}: ${JSON.stringify(e.raw)}`,
        ),
      ].join("\n");

      expect(result.errors, message).toEqual([]);
    }

    // Also verify no tokens are accidentally detected as live expansions
    // outside of fenced code blocks. The docs should only have examples
    // inside fences.
    if (result.expansions.length > 0) {
      const message = [
        "assistant/docs/skills.md has inline expansion tokens outside fenced code blocks.",
        "These would be treated as live commands if the file were loaded as a skill.",
        "Move all examples inside ``` or ~~~ fenced blocks.",
        "",
        "Live tokens found:",
        ...result.expansions.map(
          (e) =>
            "  - !" + "`" + e.command + "`" + " at offset " + e.startOffset,
        ),
      ].join("\n");

      expect(result.expansions, message).toEqual([]);
    }
  });
});
