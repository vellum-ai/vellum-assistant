/**
 * Guard test: per-call-site LLM tuning (`max_tokens` / `temperature`) must live
 * in `CALL_SITE_DEFAULTS` (assistant/src/config/call-site-defaults.ts), NOT
 * inline in `sendMessage` / `runOneShotLLM` / `runBtwSidechain` config objects.
 *
 * Why: when a literal is hardcoded inline, it always wins over the resolved
 * call-site config (see `normalizeSendMessageOptions` in providers/retry.ts —
 * resolved values only fill `nextConfig.max_tokens`/`temperature` when the
 * field is `undefined`). That silently no-ops operator/user tuning via
 * `llm.callSites.<id>.maxTokens` / `.temperature` for those knobs and makes
 * `call-site-defaults.ts` no longer the single source of truth.
 *
 * Scope: this scans `assistant/src` for NUMERIC `max_tokens:`/`temperature:`
 * literals that live inside a `config: { ... }` object that also carries a
 * `callSite:` key (i.e. an LLM request config). It intentionally does NOT flag:
 *   - non-numeric values (e.g. `max_tokens: maxTokens` — a genuine per-request
 *     value computed from input length),
 *   - literals in `assistant/src/config/` (where defaults legitimately live),
 *   - literals in `assistant/src/providers/` (the adapters/resolver that apply
 *     resolved values to the wire),
 *   - test files,
 *   - non-LLM config objects (TTS request bodies, migration seed data) — those
 *     have no `callSite:` key in the same config block.
 *
 * Escape hatch: prefix the offending property with a
 * `// call-site-tuning:allow — reason: <why>` comment on the line directly
 * above for legitimately dynamic per-request values (e.g. `diagnostics-routes.ts`
 * derives `max_tokens` from transcription length; `conversation.ts` warms the
 * prompt cache with a fixed 1-token completion that must not flow from config).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

const SUPPRESSION_MARKER = "call-site-tuning:allow";

/** Directories where inline tuning literals are legitimate. */
const EXCLUDED_DIR_PREFIXES = [
  "assistant/src/config/",
  "assistant/src/providers/",
];

function isExcludedPath(relPath: string): boolean {
  if (relPath.includes("__tests__")) return true;
  if (relPath.endsWith(".test.ts")) return true;
  return EXCLUDED_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * Walk upward from `fromIdx` over the contiguous run of comment lines and
 * return true if any carries the suppression marker.
 */
function markerInCommentRunAbove(lines: string[], fromIdx: number): boolean {
  for (let i = fromIdx; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.includes(SUPPRESSION_MARKER)) return true;
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    break;
  }
  return false;
}

/**
 * A property is suppressed when the marker appears on its own line, in the
 * contiguous comment run directly above the property, or in the contiguous
 * comment run directly above the enclosing `config: {` opener. The last form
 * lets one comment cover the whole block (the common idiom when several tuned
 * fields move into defaults together).
 */
function isSuppressed(
  lines: string[],
  lineIdx: number,
  configOpenerIdx: number,
): boolean {
  if (lines[lineIdx].includes(SUPPRESSION_MARKER)) return true;
  if (markerInCommentRunAbove(lines, lineIdx - 1)) return true;
  if (markerInCommentRunAbove(lines, configOpenerIdx - 1)) return true;
  return false;
}

/**
 * Find `config: { ... }` blocks (brace-balanced) that contain a `callSite:`
 * key, and within them flag numeric `max_tokens:`/`temperature:` literals that
 * are not preceded by a suppression comment.
 *
 * Deliberately simple: line-oriented brace tracking from each `config: {`
 * opener. This catches the idioms used across the daemon (object literals
 * written one property per line) without a full TS parser, and stays
 * low-false-positive by requiring a sibling `callSite:` in the same block.
 */
function findViolationsInFile(relPath: string, content: string): Violation[] {
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/\bconfig\s*:\s*\{/.test(lines[i])) continue;

    // Walk the brace-balanced block starting at this line.
    let depth = 0;
    let started = false;
    const blockLines: { line: number; text: string }[] = [];
    let j = i;
    for (; j < lines.length; j++) {
      const text = lines[j];
      for (const ch of text) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") {
          depth--;
        }
      }
      blockLines.push({ line: j, text });
      if (started && depth <= 0) break;
    }

    const blockText = blockLines.map((b) => b.text).join("\n");
    // Only LLM request configs carry a `callSite`. Skip everything else
    // (TTS bodies, migration seed data, unrelated `config` objects).
    if (!/\bcallSite\s*:/.test(blockText)) continue;

    for (let k = 0; k < blockLines.length; k++) {
      const { line, text } = blockLines[k];
      // Strip line comments so a comment mentioning `temperature: 0` (e.g. the
      // rationale notes in agent-runner.ts) is never flagged.
      const code = text.replace(/\/\/.*$/, "");
      if (!/\b(max_tokens|temperature)\s*:\s*-?\d/.test(code)) continue;

      if (isSuppressed(lines, line, i)) continue;

      violations.push({ file: relPath, line: line + 1, text: text.trim() });
    }

    // Continue scanning after this block.
    i = j;
  }

  return violations;
}

describe("call-site tuning guard", () => {
  test("no inline numeric max_tokens/temperature in LLM request configs", () => {
    const repoRoot = join(process.cwd(), "..");
    const violations: Violation[] = [];

    for (const relPath of new Glob("assistant/src/**/*.ts").scanSync({
      cwd: repoRoot,
    })) {
      if (isExcludedPath(relPath)) continue;
      const content = readFileSync(join(repoRoot, relPath), "utf-8");
      violations.push(...findViolationsInFile(relPath, content));
    }

    if (violations.length > 0) {
      const message = [
        "Found inline numeric max_tokens/temperature literals in LLM request",
        "config objects. Per-call-site tuning must live in CALL_SITE_DEFAULTS",
        "(assistant/src/config/call-site-defaults.ts) so `llm.callSites.<id>`",
        "operator/user tuning is honored — inline literals always win over the",
        "resolved value (see providers/retry.ts normalizeSendMessageOptions).",
        "",
        "For genuinely dynamic per-request values, add a",
        `\`// ${SUPPRESSION_MARKER} — reason: <why>\` comment on the line above.`,
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v.file}:${v.line}  ${v.text}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  // Exercise the detection logic directly so the positive path is covered even
  // when the live tree is clean.
  test("flags a numeric literal inside an LLM config block", () => {
    const src = [
      "provider.sendMessage(messages, {",
      "  config: {",
      '    callSite: "preferenceExtraction",',
      "    max_tokens: 1024,",
      "  },",
      "});",
    ].join("\n");
    const violations = findViolationsInFile("assistant/src/fixture.ts", src);
    expect(violations).toHaveLength(1);
    expect(violations[0].text).toBe("max_tokens: 1024,");
  });

  test("flags a numeric temperature literal inside an LLM config block", () => {
    const src = [
      "  config: {",
      '    callSite: "conversationStarters",',
      "    temperature: 0.7,",
      "  },",
    ].join("\n");
    const violations = findViolationsInFile("assistant/src/fixture.ts", src);
    expect(violations).toHaveLength(1);
    expect(violations[0].text).toBe("temperature: 0.7,");
  });

  test("ignores non-numeric (dynamic) values", () => {
    const src = [
      "  config: {",
      '    callSite: "interactionClassifier",',
      "    max_tokens: maxTokens,",
      "  },",
    ].join("\n");
    expect(findViolationsInFile("assistant/src/fixture.ts", src)).toEqual([]);
  });

  test("ignores config blocks without a callSite (e.g. TTS bodies)", () => {
    const src = [
      "  config: {",
      "    temperature: 1.0,",
      "    speed: 1.0,",
      "  },",
    ].join("\n");
    expect(findViolationsInFile("assistant/src/fixture.ts", src)).toEqual([]);
  });

  test("ignores literals mentioned only in comments", () => {
    const src = [
      "  config: {",
      '    callSite: "recall",',
      "    // temperature: 0 lives in the call-site defaults now",
      "  },",
    ].join("\n");
    expect(findViolationsInFile("assistant/src/fixture.ts", src)).toEqual([]);
  });

  test("honors a suppression comment above the config opener", () => {
    const src = [
      "  // call-site-tuning:allow — reason: cache-warming 1-token completion",
      "  config: {",
      '    callSite: "mainAgent",',
      "    max_tokens: 1,",
      "  },",
    ].join("\n");
    expect(findViolationsInFile("assistant/src/fixture.ts", src)).toEqual([]);
  });

  test("honors a suppression comment above the property", () => {
    const src = [
      "  config: {",
      '    callSite: "interactionClassifier",',
      "    // call-site-tuning:allow — reason: scales with input length",
      "    max_tokens: 512,",
      "  },",
    ].join("\n");
    expect(findViolationsInFile("assistant/src/fixture.ts", src)).toEqual([]);
  });
});
