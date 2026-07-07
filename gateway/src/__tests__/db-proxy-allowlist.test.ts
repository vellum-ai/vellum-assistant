import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * db_proxy surface guard: the assistant-DB proxy (`assistant-db-proxy.ts` +
 * the daemon-side `db-proxy` route) is a temporary raw-SQL bridge, slated for
 * removal once its last callers get typed ops. This source scan
 * fails if any gateway file OUTSIDE the allowlist imports the proxy or names
 * either raw-SQL bridge method (`db_proxy` / `db_proxy_transaction`), so the
 * surface can only shrink, never grow.
 *
 * The proxy currently serves two groups (the allowlist below):
 *   1. The contact-merge identity-mirror cluster (`contact-store.ts`) — a
 *      notes-only survivor UPDATE and a resolved-slug dual-write INSERT that no
 *      existing typed mirror op expresses; pending a merge-shaped op.
 *   2. Data migrations — one-time backfills that legitimately touch the
 *      assistant DB broadly.
 */

// Relative to GATEWAY_SRC (POSIX-separated). Every entry is a sanctioned
// db_proxy caller; new callers must NOT be added — drain them instead.
const ALLOWLIST = new Set<string>([
  // The proxy definition itself (calls ipcCallAssistant("db_proxy")).
  "db/assistant-db-proxy.ts",

  // Contact-merge identity-mirror cluster. Pending a merge-shaped op: a
  // notes-only survivor UPDATE (must not overwrite the survivor's display
  // name) and a resolved user_file slug seeded on the dual-write-gap INSERT.
  "db/contact-store.ts",
]);

// Data migrations run one-time backfills through the same proxy and touch
// contacts/channels/invites broadly. Allowed wholesale by directory prefix.
const ALLOWED_DIR_PREFIX = "db/data-migrations/";

const GATEWAY_SRC = join(import.meta.dirname!, "..");

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

function relPosix(file: string): string {
  return file.slice(GATEWAY_SRC.length + 1).split(sep).join("/");
}

// A static/dynamic import of the proxy module, or a direct db_proxy IPC call.
const IMPORTS_PROXY =
  /(?:from|import)\s*\(?\s*["'`][^"'`]*assistant-db-proxy(?:\.js)?["'`]/;
// Matches either raw-SQL bridge method (`db_proxy` / `db_proxy_transaction`) by
// the quoted method name itself — single, double, OR backtick quotes —
// independent of the callee identifier, so aliasing `ipcCallAssistant`, stashing
// it in a local, or a template-literal method string cannot slip a new raw-SQL
// caller past the guard. The method-name string only appears at these call sites
// (verified: no bare-mention false positives in the scanned tree). A regex scan
// cannot catch a fully dynamic name (e.g. "db_" + "proxy"); that residual is
// accepted — the surface can still only shrink, never grow, for realistic code.
const CALLS_DB_PROXY = /["'`]db_proxy(?:_transaction)?["'`]/;

// Strip `//` line and `/* */` block comments so a doc-comment mention of the
// method name (markdown code spans use backticks) can't trip the matcher — only
// real code is scanned.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** True if `src` reaches the assistant-DB proxy (import or direct IPC call). */
function usesDbProxy(src: string): boolean {
  const code = stripComments(src);
  return IMPORTS_PROXY.test(code) || CALLS_DB_PROXY.test(code);
}

describe("db_proxy caller allowlist guard", () => {
  test("only allowlisted gateway files reach the db_proxy", () => {
    const violations: string[] = [];

    for (const file of collectSourceFiles(GATEWAY_SRC)) {
      const rel = relPosix(file);
      if (ALLOWLIST.has(rel) || rel.startsWith(ALLOWED_DIR_PREFIX)) continue;
      if (usesDbProxy(readFileSync(file, "utf-8"))) {
        violations.push(rel);
      }
    }

    expect(violations).toEqual([]);
  });

  test("matcher detects both proxy imports and direct db_proxy calls", () => {
    expect(
      usesDbProxy(`import { assistantDbRun } from "../db/assistant-db-proxy.js";`),
    ).toBe(true);
    expect(
      usesDbProxy(`const m = await import("./db/assistant-db-proxy.js");`),
    ).toBe(true);
    // Template-literal module specifiers are caught too.
    expect(
      usesDbProxy("const m = await import(`./db/assistant-db-proxy.js`);"),
    ).toBe(true);
    expect(usesDbProxy(`await ipcCallAssistant("db_proxy", { sql });`)).toBe(
      true,
    );
    // The transaction variant of the same raw-SQL bridge is also caught.
    expect(
      usesDbProxy(`await ipcCallAssistant("db_proxy_transaction", { steps });`),
    ).toBe(true);
    // Aliased / indirected callees are caught via the method-name string.
    expect(
      usesDbProxy(`import { ipcCallAssistant as call } from "x";\ncall("db_proxy", { sql });`),
    ).toBe(true);
    expect(
      usesDbProxy(`const M = "db_proxy_transaction";\nawait send(M, { steps });`),
    ).toBe(true);
    // Template-literal method strings (backtick-quoted) are caught too.
    expect(usesDbProxy("await ipcCallAssistant(`db_proxy`, { sql });")).toBe(
      true,
    );
    // Unrelated IPC methods and identifiers must NOT match.
    expect(
      usesDbProxy(`await ipcCallAssistant("contacts_mirror_upsert_channel", {});`),
    ).toBe(false);
    expect(usesDbProxy(`import { getGatewayDb } from "../db/connection.js";`)).toBe(
      false,
    );
    // A doc-comment mention of the method name must NOT count as a caller.
    expect(usesDbProxy("/**\n * `db_proxy` SELECTs the gateway used to run.\n */")).toBe(
      false,
    );
    expect(usesDbProxy(`// legacy db_proxy("db_proxy") note\nconst x = 1;`)).toBe(
      false,
    );
  });

  test("every allowlisted file exists and still reaches the db_proxy", () => {
    for (const rel of ALLOWLIST) {
      const full = join(GATEWAY_SRC, ...rel.split("/"));
      expect(existsSync(full)).toBe(true);
      expect(usesDbProxy(readFileSync(full, "utf-8"))).toBe(true);
    }
  });
});
