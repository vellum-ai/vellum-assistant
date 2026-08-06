import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * Guard test: every generated SDK operation whose success response is binary
 * must be called with an explicit `parseAs`.
 *
 * `api-interceptors.ts` sets `parseAs: "json"` on all four generated clients.
 * That is deliberate (HeyAPI's default `parseAs: "auto"` infers the strategy
 * from the response `Content-Type`, and falls back to `"stream"` when the
 * header is absent, handing back `response.body` as data), but it removes the
 * runtime inference that used to make binary downloads work on their own.
 * Under `"json"`, a binary endpoint called without an override runs
 * `JSON.parse` over its bytes.
 *
 * The route's content type is already declared once, in the assistant's
 * `RouteDefinition.responseBody` (`{ contentType: "application/zip", ... }`),
 * and flows through the OpenAPI spec into the generated response type. This
 * test reads that generated type rather than a hand-maintained list, so a new
 * binary endpoint is covered the moment codegen runs.
 *
 * If this fails: add `parseAs: "blob"` (or `"stream"`/`"arrayBuffer"`) to the
 * reported call site. Do not add the operation to an allowlist.
 */

const GENERATED_ROOT = join(import.meta.dir, "..", "generated");
const CLIENTS = ["daemon", "gateway", "api", "auth"] as const;

/** Source roots scanned for call sites. */
const SOURCE_ROOT = join(import.meta.dir, "..");

/** Any of these satisfies the requirement for a non-JSON response. */
const BINARY_PARSE_MODES = ["blob", "stream", "arrayBuffer", "text", "formData"];

/**
 * Operation names (generated SDK function names) whose declared success
 * response is binary, derived from `export type XResponses = { … Blob | File }`.
 */
function binaryOperations(): string[] {
  const ops: string[] = [];
  for (const client of CLIENTS) {
    let source: string;
    try {
      source = readFileSync(
        join(GENERATED_ROOT, client, "types.gen.ts"),
        "utf-8",
      );
    } catch {
      continue; // client not generated in this checkout
    }
    // Each response type is a block: `export type FooResponses = { … };`
    const blocks = source.matchAll(
      /export type (\w+)Responses = \{([\s\S]*?)\n\};/g,
    );
    for (const [, name, body] of blocks) {
      if (!name || !body) {
        continue;
      }
      if (/\bBlob \| File\b/.test(body)) {
        ops.push(`${name.charAt(0).toLowerCase()}${name.slice(1)}`);
      }
    }
  }
  return [...new Set(ops)];
}

/** Non-generated, non-test TypeScript sources under `src/`. */
function sourceFiles(): string[] {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for (const rel of glob.scanSync(SOURCE_ROOT)) {
    if (rel.startsWith("generated/")) {
      continue;
    }
    if (rel.includes(".test.") || rel.includes(".stories.")) {
      continue;
    }
    files.push(rel);
  }
  return files;
}

/**
 * The argument object of a call spans multiple lines. Take a bounded window
 * from the call site and stop at the first line that closes it, so a later
 * unrelated `parseAs` cannot mask a missing one.
 */
function callArguments(lines: string[], startIndex: number): string {
  const window: string[] = [];
  for (let i = startIndex; i < Math.min(startIndex + 25, lines.length); i++) {
    const line = lines[i] ?? "";
    window.push(line);
    if (i > startIndex && /^\s*\}\)/.test(line)) {
      break;
    }
  }
  return window.join("\n");
}

describe("binary SDK operations declare parseAs", () => {
  const operations = binaryOperations();

  test("the generated types expose at least one binary operation", () => {
    // Sensitivity check: if codegen output or its shape changes, the guard
    // must fail loudly rather than silently pass over an empty set.
    expect(operations.length).toBeGreaterThan(0);
  });

  test("every call site passes an explicit parseAs", () => {
    const files = sourceFiles();
    const violations: string[] = [];

    for (const rel of files) {
      const source = readFileSync(join(SOURCE_ROOT, rel), "utf-8");
      const lines = source.split("\n");

      for (const op of operations) {
        if (!source.includes(`${op}(`)) {
          continue;
        }
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]?.includes(`${op}(`)) {
            continue;
          }
          const args = callArguments(lines, i);
          const match = args.match(/parseAs:\s*"(\w+)"/);
          if (!match) {
            violations.push(
              `${rel}:${i + 1} calls ${op}() without parseAs (binary response)`,
            );
          } else if (!BINARY_PARSE_MODES.includes(match[1] ?? "")) {
            violations.push(
              `${rel}:${i + 1} calls ${op}() with parseAs: "${match[1]}" (binary response)`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
