import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";

/**
 * Guard tests for the assistant identity boundary.
 *
 * The daemon uses a fixed internal scope constant (`DAEMON_INTERNAL_ASSISTANT_ID`)
 * for all assistant-scoped storage. Public assistant IDs are an edge concern
 * handled by the gateway/platform layer — they must not leak into daemon
 * scoping logic.
 *
 * These tests prevent regressions by scanning source files for banned patterns:
 *  - No `normalizeAssistantId` usage in daemon/runtime scoping modules
 *  - No assistant-scoped route handlers in the daemon HTTP server
 *  - No hardcoded `'self'` string for assistant scoping (use the constant)
 *  - The constant itself equals `'self'`
 *  - No `assistantId` columns in daemon SQLite schema definitions
 *  - No `assistantId` parameter in daemon store function signatures
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve repo root (tests run from assistant/). */
function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

/**
 * Directories containing daemon/runtime source files that must not reference
 * `normalizeAssistantId` or hardcode assistant scope strings.
 *
 * Each directory gets both a `*.ts` glob (top-level files) and a `**\/*.ts`
 * glob (nested files) so that `git grep` matches at all directory depths.
 */
const SCANNED_DIRS = [
  "assistant/src/runtime",
  "assistant/src/daemon",
  "assistant/src/memory",
  "assistant/src/approvals",
  "assistant/src/calls",
  "assistant/src/tools",
];

const SCANNED_DIR_GLOBS = SCANNED_DIRS.flatMap((dir) => [
  `${dir}/*.ts`,
  `${dir}/**/*.ts`,
]);

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("/__tests__/") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.js") ||
    filePath.endsWith(".spec.ts") ||
    filePath.endsWith(".spec.js")
  );
}

function isMigrationFile(filePath: string): boolean {
  return filePath.includes("/migrations/");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant ID boundary", () => {
  // -------------------------------------------------------------------------
  // Rule (d): The DAEMON_INTERNAL_ASSISTANT_ID constant equals 'self'
  // -------------------------------------------------------------------------

  test('DAEMON_INTERNAL_ASSISTANT_ID equals "self"', () => {
    expect(DAEMON_INTERNAL_ASSISTANT_ID).toBe("self");
  });

  // -------------------------------------------------------------------------
  // Rule (a): No normalizeAssistantId in daemon scoping paths — spot check
  // -------------------------------------------------------------------------

  test("no normalizeAssistantId imports in daemon scoping paths", () => {
    // Key daemon/runtime files that previously used normalizeAssistantId
    // should now use DAEMON_INTERNAL_ASSISTANT_ID instead.
    const daemonScopingFiles = [
      "runtime/actor-trust-resolver.ts",
      "runtime/verification-outbound-actions.ts",
      "daemon/handlers/config-channels.ts",
      "runtime/routes/channel-route-shared.ts",
      "calls/relay-server.ts",
    ];

    const srcDir = join(import.meta.dir, "..");
    for (const relPath of daemonScopingFiles) {
      const content = readFileSync(join(srcDir, relPath), "utf-8");
      expect(content).not.toContain("import { normalizeAssistantId }");
      expect(content).not.toContain("import { normalizeAssistantId,");
      expect(content).not.toContain("normalizeAssistantId(");
    }
  });

  // -------------------------------------------------------------------------
  // Rule (a): No normalizeAssistantId in daemon/runtime directories — broad scan
  // -------------------------------------------------------------------------

  test("no normalizeAssistantId usage across daemon/runtime source directories", () => {
    const repoRoot = getRepoRoot();

    // Scan all daemon/runtime source directories for any reference to
    // normalizeAssistantId. The function is defined in util/platform.ts for
    // gateway use — it must not appear in daemon scoping modules.
    let grepOutput = "";
    try {
      grepOutput = execFileSync(
        "git",
        ["grep", "-lE", "normalizeAssistantId", "--", ...SCANNED_DIR_GLOBS],
        { encoding: "utf-8", cwd: repoRoot },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const files = grepOutput.split("\n").filter((f) => f.length > 0);
    const violations = files.filter((f) => !isTestFile(f));

    if (violations.length > 0) {
      const message = [
        "Found daemon/runtime source files that reference `normalizeAssistantId`.",
        "Daemon code should use the `DAEMON_INTERNAL_ASSISTANT_ID` constant instead.",
        "The `normalizeAssistantId` function is for gateway/platform use only (defined in util/platform.ts).",
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // Rule (b): No assistant-scoped route registration in daemon HTTP server
  // -------------------------------------------------------------------------

  test("no /v1/assistants/:assistantId/ route handler registration in daemon HTTP server", () => {
    const httpServerPath = join(
      import.meta.dir,
      "..",
      "runtime",
      "http-server.ts",
    );
    const content = readFileSync(httpServerPath, "utf-8");

    // The daemon HTTP server must not contain any assistant-scoped route
    // patterns. All routes use flat /v1/<endpoint> paths; the gateway handles
    // legacy assistant-scoped URL rewriting in its runtime proxy layer.

    // Check that there's no regex extracting assistantId from a /v1/assistants/ path.
    // Match both literal slashes (/v1/assistants/([) and escaped slashes in regex
    // literals (\/v1\/assistants\/([) so we catch patterns like:
    //   endpoint.match(/^\/v1\/assistants\/([^/]+)\/(.+)$/)
    const routeHandlerRegex = /\\?\/v1\\?\/assistants\\?\/\(\[/;
    const match = content.match(routeHandlerRegex);
    expect(
      match,
      "Found a route pattern matching /v1/assistants/([^/]+)/... that extracts an assistantId. " +
        "The daemon HTTP server should not have assistant-scoped route handlers — " +
        "use flat /v1/<endpoint> paths instead.",
    ).toBeNull();

    // Scan the entire file for assistant-scoped path literals. No references
    // to /v1/assistants/ should exist — the daemon uses flat paths only.
    const lines = content.split("\n");
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match both literal /v1/assistants/ and escaped \/v1\/assistants\/
      if (
        line.includes("/v1/assistants/") ||
        line.includes("\\/v1\\/assistants\\/")
      ) {
        violations.push(`  line ${i + 1}: ${line.trim()}`);
      }
    }

    expect(
      violations,
      "Found /v1/assistants/ references in the daemon HTTP server — " +
        "the daemon should not have assistant-scoped path literals.\n" +
        violations.join("\n"),
    ).toEqual([]);

    // Guard against prefix-less assistants/ route patterns that extract an
    // assistantId.  dispatchEndpoint receives the endpoint *after* the /v1/
    // prefix has been stripped, so a regex like `assistants\/([^/]+)` would
    // capture an external assistant ID from the path — violating the
    // assistant-scoping boundary.
    const prefixLessViolations: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match regex patterns like assistants\/([^/]+) that capture the ID
      // segment.  We look for the escaped-slash form used inside JS regex
      // literals (e.g. /^assistants\/([^/]+)\//).
      if (/assistants\\\/\(\[/.test(line)) {
        prefixLessViolations.push(`  line ${i + 1}: ${line.trim()}`);
      }
    }

    expect(
      prefixLessViolations,
      "Found prefix-less assistants/([^/]+) route pattern that extracts an assistantId. " +
        "The daemon should not parse assistant IDs from URL paths — use " +
        "DAEMON_INTERNAL_ASSISTANT_ID instead.\n" +
        prefixLessViolations.join("\n"),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Rule (c): No hardcoded 'self' for assistant scoping in daemon files
  // -------------------------------------------------------------------------

  test("no hardcoded 'self' string for assistant scoping in daemon source files", () => {
    const repoRoot = getRepoRoot();

    // Search for patterns where 'self' is used as an assistant ID value.
    // We look for assignment / default / comparison patterns that suggest
    // using the raw string instead of the DAEMON_INTERNAL_ASSISTANT_ID constant.
    //
    // Patterns matched:
    //   assistantId: 'self'
    //   assistantId = 'self'
    //   assistantId ?? 'self'
    //   ?? 'self'   (fallback to self)
    //   || 'self'   (fallback to self)
    //
    // Excluded:
    //   - Test files (they may legitimately assert against the value)
    //   - Migration files (SQL literals like DEFAULT 'self' are fine)
    //   - Message contract files (comments documenting default values are fine)
    //   - CSP headers ('self' in Content-Security-Policy has nothing to do with assistant IDs)
    const pattern = `(assistantId|assistant_id).*['"]self['"]`;

    let grepOutput = "";
    try {
      grepOutput = execFileSync(
        "git",
        ["grep", "-nE", pattern, "--", ...SCANNED_DIR_GLOBS],
        { encoding: "utf-8", cwd: repoRoot },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const lines = grepOutput.split("\n").filter((l) => l.length > 0);
    const violations = lines.filter((line) => {
      const filePath = line.split(":")[0];
      if (isTestFile(filePath)) return false;
      if (isMigrationFile(filePath)) return false;

      // Allow comments (lines where the code portion starts with //)
      const parts = line.split(":");
      // parts[0] = file, parts[1] = line number, rest = content
      const content = parts.slice(2).join(":").trim();
      if (
        content.startsWith("//") ||
        content.startsWith("*") ||
        content.startsWith("/*")
      ) {
        return false;
      }

      return true;
    });

    if (violations.length > 0) {
      const message = [
        "Found daemon/runtime source files with hardcoded 'self' for assistant scoping.",
        "Use the `DAEMON_INTERNAL_ASSISTANT_ID` constant from `runtime/assistant-scope.ts` instead.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // Rule (d): Daemon storage keys don't contain external assistant IDs
  // (verified by the constant value test above — if the constant is 'self',
  // all daemon storage keyed by DAEMON_INTERNAL_ASSISTANT_ID uses the fixed
  // internal value rather than externally-provided IDs).
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Rule (e): No assistantId on daemon control-plane request/param types
  //
  // Daemon message contracts and guardian outbound param interfaces must not
  // accept an assistantId field -- the daemon always uses
  // DAEMON_INTERNAL_ASSISTANT_ID internally. Accepting assistantId on these
  // surfaces invites callers to pass external IDs into daemon scoping.
  // -------------------------------------------------------------------------

  test("message contract types do not contain assistantId for guardian requests", () => {
    const contractPath = join(
      import.meta.dir,
      "..",
      "daemon",
      "message-types",
      "integrations.ts",
    );
    const content = readFileSync(contractPath, "utf-8");

    // Extract the interface blocks for the request types and verify
    // none of them declare an assistantId property.
    const requestTypeNames = ["ChannelVerificationSessionRequest"];

    for (const typeName of requestTypeNames) {
      // Find the interface/type block — match from the type name to the next
      // closing brace at the same indentation level. We use a simple heuristic:
      // find the line declaring the type, then scan forward to the closing '}'.
      const typeIndex = content.indexOf(typeName);
      expect(
        typeIndex,
        `Expected to find ${typeName} in message contract`,
      ).toBeGreaterThan(-1);

      // Extract from the type declaration to the next '}' line
      const blockStart = content.indexOf("{", typeIndex);
      if (blockStart === -1) continue;
      let braceDepth = 0;
      let blockEnd = blockStart;
      for (let i = blockStart; i < content.length; i++) {
        if (content[i] === "{") braceDepth++;
        if (content[i] === "}") braceDepth--;
        if (braceDepth === 0) {
          blockEnd = i + 1;
          break;
        }
      }
      const block = content.slice(blockStart, blockEnd);

      // The block should not contain an assistantId property declaration
      // (matches "assistantId?" or "assistantId:" on a non-comment line)
      const lines = block.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*")
        )
          continue;
        expect(
          /\bassistantId\s*[?:]/.test(trimmed),
          `${typeName} must not declare an assistantId property. Found: "${trimmed}"`,
        ).toBe(false);
      }
    }
  });

  test("guardian outbound param interfaces do not contain assistantId", () => {
    const actionsPath = join(
      import.meta.dir,
      "..",
      "runtime",
      "verification-outbound-actions.ts",
    );
    const content = readFileSync(actionsPath, "utf-8");

    const interfaceNames = [
      "StartOutboundParams",
      "ResendOutboundParams",
      "CancelOutboundParams",
    ];

    for (const name of interfaceNames) {
      const idx = content.indexOf(name);
      expect(
        idx,
        `Expected to find ${name} in verification-outbound-actions.ts`,
      ).toBeGreaterThan(-1);

      const blockStart = content.indexOf("{", idx);
      if (blockStart === -1) continue;
      let braceDepth = 0;
      let blockEnd = blockStart;
      for (let i = blockStart; i < content.length; i++) {
        if (content[i] === "{") braceDepth++;
        if (content[i] === "}") braceDepth--;
        if (braceDepth === 0) {
          blockEnd = i + 1;
          break;
        }
      }
      const block = content.slice(blockStart, blockEnd);

      const lines = block.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*")
        )
          continue;
        expect(
          /\bassistantId\s*[?:]/.test(trimmed),
          `${name} must not declare an assistantId property. Found: "${trimmed}"`,
        ).toBe(false);
      }
    }
  });

  test("channel readiness service does not accept assistantId parameter", () => {
    const servicePath = join(
      import.meta.dir,
      "..",
      "runtime",
      "channel-readiness-service.ts",
    );
    const content = readFileSync(servicePath, "utf-8");

    // getReadiness and invalidateChannel signatures must not include assistantId
    const signaturePatterns = [
      /getReadiness\([^)]*assistantId/,
      /invalidateChannel\([^)]*assistantId/,
    ];
    for (const pattern of signaturePatterns) {
      expect(
        pattern.test(content),
        `Channel readiness service must not accept assistantId parameter (matched: ${pattern})`,
      ).toBe(false);
    }

    // ChannelProbeContext must not have assistantId.
    // The interface is declared in channel-readiness-types.ts, not the service file.
    const typesPath = join(
      import.meta.dir,
      "..",
      "runtime",
      "channel-readiness-types.ts",
    );
    const typesContent = readFileSync(typesPath, "utf-8");
    const probeContextMatch = typesContent.match(
      /interface\s+ChannelProbeContext\s*\{([^}]*)\}/,
    );
    expect(
      probeContextMatch,
      "Expected to find ChannelProbeContext interface in channel-readiness-types.ts",
    ).not.toBeNull();
    if (probeContextMatch) {
      expect(
        probeContextMatch[1],
        "ChannelProbeContext must not contain assistantId",
      ).not.toContain("assistantId");
    }
  });

  // -------------------------------------------------------------------------
  // Rule (f): No assistantId columns in daemon SQLite schema definitions
  //
  // The daemon is assistant-agnostic — it uses DAEMON_INTERNAL_ASSISTANT_ID
  // implicitly. Schema files must not define assistantId columns, which would
  // re-introduce assistant-scoped storage in the daemon layer.
  // -------------------------------------------------------------------------

  test("no assistantId columns in daemon SQLite schema definitions", () => {
    const repoRoot = getRepoRoot();

    // Scan all Drizzle schema files for assistantId column definitions.
    // Match `assistantId:` followed by any Drizzle column builder (text(,
    // integer(, blob(, real(, etc.) — not just text(.
    const schemaGlobs = [
      "assistant/src/memory/schema/*.ts",
      "assistant/src/memory/schema/**/*.ts",
    ];

    let grepOutput = "";
    try {
      grepOutput = execFileSync(
        "git",
        ["grep", "-nE", "assistantId\\s*:", "--", ...schemaGlobs],
        { encoding: "utf-8", cwd: repoRoot },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const lines = grepOutput.split("\n").filter((l) => l.length > 0);
    const violations = lines.filter((line) => {
      // Allow comments
      const parts = line.split(":");
      const content = parts.slice(2).join(":").trim();
      if (
        content.startsWith("//") ||
        content.startsWith("*") ||
        content.startsWith("/*")
      ) {
        return false;
      }
      return true;
    });

    if (violations.length > 0) {
      const message = [
        "Found `assistantId` column definitions in daemon SQLite schema files.",
        "`assistantId` columns are not allowed in daemon schema — the daemon uses",
        "`DAEMON_INTERNAL_ASSISTANT_ID` implicitly and is assistant-agnostic.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // Rule (g): No assistantId parameter in daemon store function signatures
  //
  // Store functions in the daemon layer must not accept assistantId as a
  // parameter. The daemon is assistant-agnostic — all assistant scoping
  // uses DAEMON_INTERNAL_ASSISTANT_ID internally.
  // -------------------------------------------------------------------------

  test("no assistantId parameter in daemon store function signatures", () => {
    const repoRoot = getRepoRoot();

    // Scan store files for exported function signatures that include
    // assistantId as a parameter. This covers memory stores, contact stores,
    // notification stores, credential/token stores, and call stores.
    //
    // We read each file and extract full parameter lists (which may span
    // multiple lines) from exported functions to catch multiline signatures.
    const storeGlobs = [
      "assistant/src/memory/*.ts",
      "assistant/src/contacts/*.ts",
      "assistant/src/notifications/*.ts",
      "assistant/src/runtime/actor-token-store.ts",

      "assistant/src/calls/call-store.ts",
    ];

    // Find matching files using git ls-files with each glob
    const matchedFiles: string[] = [];
    for (const glob of storeGlobs) {
      try {
        const output = execFileSync("git", ["ls-files", "--", glob], {
          encoding: "utf-8",
          cwd: repoRoot,
        }).trim();
        if (output) {
          matchedFiles.push(...output.split("\n").filter((f) => f.length > 0));
        }
      } catch {
        // Ignore errors — glob may not match anything
      }
    }

    const violations: string[] = [];

    // Regex to find the start of an exported function declaration or
    // arrow-function expression. We capture everything from `export` up to
    // and including the opening parenthesis of the parameter list.
    const exportFnStartRegex =
      /export\s+(?:async\s+)?function\s+\w+\s*\(|export\s+const\s+\w+\s*=\s*(?:async\s+)?\(/g;

    for (const relPath of matchedFiles) {
      if (isTestFile(relPath) || isMigrationFile(relPath)) continue;

      const content = readFileSync(join(repoRoot, relPath), "utf-8");

      exportFnStartRegex.lastIndex = 0;
      for (
        let match = exportFnStartRegex.exec(content);
        match;
        match = exportFnStartRegex.exec(content)
      ) {
        // Skip matches that fall inside comments. Find the beginning of
        // the line containing the match and check for comment prefixes.
        const lineStart = content.lastIndexOf("\n", match.index) + 1;
        const linePrefix = content.slice(lineStart, match.index).trim();
        if (linePrefix.startsWith("//")) {
          continue;
        }
        // For block comments: check if the match is inside an unclosed
        // block comment. A prefix starting with `*` (continuation line)
        // or `/*` only counts if there is no closing `*/` between the
        // last `/*` opener and the match position — otherwise the
        // comment was already closed (e.g. `/** docs */ export …`).
        if (linePrefix.startsWith("*") || linePrefix.startsWith("/*")) {
          const textBeforeMatch = content.slice(lineStart, match.index);
          const lastOpen = textBeforeMatch.lastIndexOf("/*");
          if (lastOpen === -1) {
            // No block-comment opener on this line but starts with `*`,
            // so it's a continuation line inside a multi-line comment.
            continue;
          }
          const closeBetween = textBeforeMatch.indexOf("*/", lastOpen + 2);
          if (closeBetween === -1) {
            // The block comment is still open at the match position.
            continue;
          }
          // The block comment was closed before the match — fall through
          // and evaluate the match normally.
        }

        // Find the matching closing paren to extract the full parameter list,
        // which may span multiple lines.
        const parenStart = match.index + match[0].length - 1; // index of '('
        let depth = 1;
        let paramEnd = parenStart + 1;
        for (let i = parenStart + 1; i < content.length && depth > 0; i++) {
          if (content[i] === "(") depth++;
          if (content[i] === ")") depth--;
          if (depth === 0) {
            paramEnd = i;
            break;
          }
        }

        const paramList = content.slice(parenStart + 1, paramEnd);

        // Check if the parameter list contains assistantId as a word boundary
        if (/\bassistantId\b/.test(paramList)) {
          // Determine the line number of the export keyword for reporting
          const lineNum = content.slice(0, match.index).split("\n").length;
          const firstLine = content
            .slice(match.index, match.index + match[0].length)
            .trim();
          violations.push(`${relPath}:${lineNum}: ${firstLine}...`);
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        "Found daemon store functions with `assistantId` in their parameter signatures.",
        "Store functions must not accept `assistantId` — the daemon is assistant-agnostic",
        "and uses `DAEMON_INTERNAL_ASSISTANT_ID` implicitly.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});
