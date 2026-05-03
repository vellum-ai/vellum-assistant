/**
 * Static-analysis guard for the AppControl Swift sources.
 *
 * The app-control surface targets a *specific* host process — events must
 * be delivered with `CGEvent.postToPid(_:)` (Swift-bridged) or its C-symbol
 * equivalent `CGEventPostToPid(...)`. The deprecated global form
 * `CGEventPost(...)` posts to the system-wide event tap, which would leak
 * input to whichever app currently has user focus. That defeats the whole
 * point of per-process app control and is a security hazard, so we keep
 * it out of `clients/macos/vellum-assistant/AppControl/` entirely.
 *
 * The guard flags any standalone `CGEventPost(...)` call (i.e. the parens
 * follow the symbol directly, not preceded by `.`). Allowed forms:
 *   - `CGEvent.postToPid(_:)`   (Swift-bridged, modern idiom)
 *   - `CGEventPostToPid(...)`   (C-symbol, process-scoped)
 *   - any line carrying a `// allow: CGEventPost` suppression comment
 *
 * If a real call site ever needs the global form, the suppression comment
 * makes the intent explicit.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const APP_CONTROL_DIR = join(
  process.cwd(),
  "..",
  "clients",
  "macos",
  "vellum-assistant",
  "AppControl",
);

/** Recursively collect `.swift` files under `dir`. */
function collectSwiftFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSwiftFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".swift")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Match a global `CGEventPost(` call: the literal symbol followed
 * immediately by `(`. We use a negative lookbehind to exclude:
 *   - `.CGEventPost(` (member access, not a real Swift form but harmless)
 *   - `CGEventPostToPid(` (process-scoped C symbol — allowed)
 *   - `CGEvent.postToPid(` (Swift-bridged form — does not match anyway,
 *     the symbol there is `postToPid`).
 *
 * The regex is intentionally narrow: `\bCGEventPost\(` matches only
 * `CGEventPost(`. `CGEventPostToPid(` does not match because the substring
 * after `CGEventPost` is `T`, not `(`.
 */
const GLOBAL_CGEVENT_POST = /\bCGEventPost\(/;

/** Suppression comment that whitelists a single line. */
const ALLOW_COMMENT = /\/\/\s*allow:\s*CGEventPost/i;

describe("app-control: no global CGEventPost in Swift sources", () => {
  test("CGEventPost(...) is forbidden in clients/macos/vellum-assistant/AppControl/", () => {
    const files = collectSwiftFiles(APP_CONTROL_DIR);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!GLOBAL_CGEVENT_POST.test(line)) continue;
        if (ALLOW_COMMENT.test(line)) continue;
        violations.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    }

    if (violations.length > 0) {
      const message = [
        "Found global CGEventPost(...) calls in AppControl Swift sources.",
        "App-control input must be process-scoped — use CGEvent.postToPid(_:)",
        "(Swift-bridged form) or CGEventPostToPid(...) (C-symbol form). The",
        "global form leaks events to whichever app currently has user focus.",
        "",
        "If a specific call site genuinely needs the global form, append a",
        "`// allow: CGEventPost` comment to that line to suppress this guard.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });
});
