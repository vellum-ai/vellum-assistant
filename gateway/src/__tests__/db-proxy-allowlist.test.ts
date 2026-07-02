import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * db_proxy surface guard: the assistant-DB proxy (`assistant-db-proxy.ts` +
 * the daemon-side `db-proxy` route) is a temporary raw-SQL bridge, slated for
 * removal with the verification-session source-of-truth move. This source scan
 * fails if any gateway file OUTSIDE the allowlist imports the proxy or calls
 * `ipcCallAssistant("db_proxy")`, so the surface can only shrink, never grow.
 *
 * The proxy currently serves three groups (the allowlist below):
 *   1. Verification-session + rate-limit state — dies with the session-SoT move.
 *   2. The contact-merge identity-mirror cluster (`contact-store.ts`) — a
 *      notes-only survivor UPDATE and a resolved-slug dual-write INSERT that no
 *      existing typed mirror op expresses; pending a merge-shaped op.
 *   3. Data migrations — one-time backfills that legitimately touch the
 *      assistant DB broadly.
 */

// Relative to GATEWAY_SRC (POSIX-separated). Every entry is a sanctioned
// db_proxy caller; new callers must NOT be added — drain them instead.
const ALLOWLIST = new Set<string>([
  // The proxy definition itself (calls ipcCallAssistant("db_proxy")).
  "db/assistant-db-proxy.ts",

  // Verification-session + rate-limit group. Retired with the session-SoT move.
  "verification/session-helpers.ts",
  "verification/rate-limit-helpers.ts",
  "verification/outbound-voice-verification-sync.ts",
  "voice/verification.ts",
  // Residual raw-SQL (type,address) lookup in the verification intercept flow;
  // identity/info reads and mirror writes are already typed IPC.
  "verification/contact-helpers.ts",

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
  /(?:from|import)\s*\(?\s*["'][^"']*assistant-db-proxy(?:\.js)?["']/;
// Matches both raw-SQL bridge methods: `db_proxy` and `db_proxy_transaction`.
const CALLS_DB_PROXY = /ipcCallAssistant\(\s*["']db_proxy(?:_transaction)?["']/;

/** True if `src` reaches the assistant-DB proxy (import or direct IPC call). */
function usesDbProxy(src: string): boolean {
  return IMPORTS_PROXY.test(src) || CALLS_DB_PROXY.test(src);
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
    expect(usesDbProxy(`await ipcCallAssistant("db_proxy", { sql });`)).toBe(
      true,
    );
    // The transaction variant of the same raw-SQL bridge is also caught.
    expect(
      usesDbProxy(`await ipcCallAssistant("db_proxy_transaction", { steps });`),
    ).toBe(true);
    // Unrelated IPC methods and identifiers must NOT match.
    expect(
      usesDbProxy(`await ipcCallAssistant("contacts_mirror_upsert_channel", {});`),
    ).toBe(false);
    expect(usesDbProxy(`import { getGatewayDb } from "../db/connection.js";`)).toBe(
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
