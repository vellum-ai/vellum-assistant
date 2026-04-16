import { execSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

/**
 * Guard test: all Meet runtime code lives under `skills/meet-join/`.
 *
 * The meet-join skill is a self-contained bundle — its daemon, tools, routes,
 * migrations, config schema, wire-contracts, and bot image all live inside
 * `skills/meet-join/`. The assistant module must NOT import from
 * `skills/meet-join/` at all — the Docker build does not copy the skill
 * directory, so any such import breaks at runtime.
 *
 * This guard keeps the Meet surface area consolidated so the skill can evolve
 * (or be lifted out of the repo entirely) without hunting down scattered
 * references. If you find yourself wanting to add a new entry to the
 * allowlist, first check whether the new code could instead live inside
 * `skills/meet-join/` or be moved into `assistant/src/`.
 */

/**
 * Files outside `skills/meet-join/` that are permitted to reference the
 * skill directory.
 *
 * Paths are relative to the repo root. When adding a new entry, include a
 * comment explaining *why* the reference is necessary (and why it cannot
 * move into the skill directory itself).
 */
const ALLOWLIST = new Set([
  // --- Daemon-client SSE protocol registry (one file per domain; stays put) ---
  "assistant/src/daemon/message-types/meet.ts", // Meet entry in the per-domain wire-protocol index (apps.ts, browser.ts, etc.); re-exported from message-protocol.ts

  // --- Container build / packaging ---
  ".dockerignore", // include/exclude rules for the skill directory
  "assistant/knip.json", // knip config for skill sub-packages dead-code analysis

  // --- CI workflows (path triggers and skill install steps) ---
  ".github/workflows/ci-main-assistant.yaml",
  ".github/workflows/ci-main-macos.yaml",
  ".github/workflows/pr-assistant.yaml",

  // --- Build scripts (macOS bundle packaging + meet-bot image build) ---
  "clients/macos/build.sh", // packages skill deps into daemon bundle
  "scripts/build-meet-bot-image.sh", // builds the meet-bot Docker image

  // --- Test runner (discovers tests inside skills/meet-join/ subpackages) ---
  "assistant/scripts/test.sh", // runs bun test across meet-join workspace packages

  // --- Documentation (top-level architecture references) ---
  "AGENTS.md", // architecture and invariant documentation
  "ARCHITECTURE.md", // architecture documentation
]);

/**
 * Patterns that indicate a reference to Meet code living under
 * `skills/meet-join/`.
 */
const MEET_REFERENCE_PATTERNS = ["skills/meet-join"];

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("/__tests__/") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.js") ||
    filePath.endsWith(".spec.ts") ||
    filePath.endsWith(".spec.js") ||
    filePath.includes("Tests/") ||
    filePath.endsWith("Tests.swift")
  );
}

function isSkillInternal(filePath: string): boolean {
  return filePath.startsWith("skills/meet-join/");
}

describe("skill-meet-isolation guard", () => {
  test("no non-allowlisted files reference skills/meet-join/", () => {
    const grepPattern = MEET_REFERENCE_PATTERNS.map((p) =>
      p.replace(/\//g, "\\/"),
    ).join("|");

    let grepOutput = "";
    try {
      grepOutput = execSync(`git grep -lE "${grepPattern}"`, {
        encoding: "utf-8",
        cwd: process.cwd() + "/..",
      }).trim();
    } catch (err) {
      // Exit code 1 means no matches — unexpected (we know imports exist),
      // but still a "pass" for the purposes of this guard.
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const files = grepOutput.split("\n").filter((f) => f.length > 0);
    const violations = files.filter((f) => {
      if (isTestFile(f)) return false;
      if (isSkillInternal(f)) return false;
      if (ALLOWLIST.has(f)) return false;
      return true;
    });

    if (violations.length > 0) {
      const message = [
        "Found non-allowlisted files referencing skills/meet-join/.",
        "All Meet runtime code must live under skills/meet-join/.",
        "See skills/meet-join/AGENTS.md for the rationale.",
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "To fix: move the new code into skills/meet-join/ and wire it via one",
        "of the existing central hooks (tool manifest, route mount, migration",
        "registry, config schema, shutdown handler, feature flag registry).",
        "If the reference is genuinely unavoidable from outside the skill,",
        "add the file path to the ALLOWLIST in skill-meet-isolation.test.ts",
        "with a comment explaining why.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});
