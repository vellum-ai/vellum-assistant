import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * DROP-safety guard: the gateway no longer WRITES the 8 ACL columns into the
 * assistant DB (the gateway DB is the source of truth). This source scan fails
 * if any assistantDbRun(/assistantDbExec( call site writes one of those columns,
 * so the assistant-side DROP-COLUMN migration (302) stays safe.
 *
 * 8 ACL columns (gateway-owned, assistant-mirror dropped):
 *   contacts.role, contacts.principal_id
 *   contact_channels.{status, policy, verified_at, verified_via,
 *                     revoked_reason, blocked_reason}
 *
 * RESIDUAL ASSISTANT-DB ACL READS still pending before the DROP:
 *   - gateway/src/db/data-migrations/m0006-*: one-time reconcile reads assistant
 *     ACL columns to seed the gateway DB.
 *   - gateway/src/db/data-migrations/m0008-*: one-time backfill reads assistant
 *     ACL columns.
 *   These append-only one-time migrations are the ONLY remaining assistant-DB
 *   ACL reads; they are retired at the assistant DROP-COLUMN migration (302).
 *   The heal/seed reads (the channel-mirror heal and the inbound contact-seed
 *   blocked-check) are drained — they read identity/info only and resolve ACL
 *   from the gateway DB. The WRITE side is clean — this guard asserts that.
 */

// Deliberate, greppable exceptions. Must stay empty: every entry is an
// assistant-DB ACL write that the DROP migration would break.
const ACL_WRITE_ALLOWLIST: string[] = [];

const ACL_COLUMNS = [
  "role",
  "principal_id",
  "status",
  "policy",
  "verified_at",
  "verified_via",
  "revoked_reason",
  "blocked_reason",
] as const;

// Info columns are assistant-owned and intentionally NOT flagged.
const INFO_COLUMNS = ["last_seen_at", "interaction_count", "last_interaction"];

const GATEWAY_SRC = join(import.meta.dirname!, "..");

const EXCLUDED_DIRS = new Set(["__tests__", "data-migrations"]);
const EXCLUDED_FILES = new Set(["assistant-db-proxy.ts"]);

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    if (EXCLUDED_FILES.has(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Extract the SQL string literal argument of an assistantDbRun/assistantDbExec
 * call starting at `callStart`. Handles template literals and quoted strings
 * spanning multiple lines. Returns the literal text (without delimiters) and
 * the index just past it, or null if no string literal follows the open paren.
 */
function extractSqlArg(
  src: string,
  callStart: number,
): { sql: string; end: number } | null {
  const open = src.indexOf("(", callStart);
  if (open === -1) return null;
  let i = open + 1;
  // Skip whitespace to the first argument.
  while (i < src.length && /\s/.test(src[i])) i++;
  const quote = src[i];
  if (quote !== "`" && quote !== '"' && quote !== "'") return null;
  const start = i + 1;
  i = start;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === quote) {
      return { sql: src.slice(start, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

// Only writes to these tables carry the dropped ACL columns. status/policy
// etc. on other tables (channel_verification_sessions, *_ingress_invites) are
// unrelated and must not be flagged.
const ACL_TABLES = ["contacts", "contact_channels"];

/** True if `sql` writes one of the 8 ACL columns into contacts/contact_channels. */
function sqlWritesAclColumn(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, " ").toLowerCase();

  // INSERT INTO <table> (col, col, ...) — an ACL column named for an ACL table.
  const insertMatch = normalized.match(
    /insert(?:\s+or\s+\w+)?\s+into\s+([a-z_]+)\s*\(([^)]*)\)/,
  );
  if (insertMatch && ACL_TABLES.includes(insertMatch[1])) {
    const cols = insertMatch[2].split(",").map((c) => c.trim());
    if (cols.some((c) => (ACL_COLUMNS as readonly string[]).includes(c))) {
      return true;
    }
  }

  // UPDATE <table> SET <acl_col> = — an ACL column assigned on an ACL table.
  // Scope to the SET clause (up to WHERE) so a WHERE-clause ACL column isn't
  // mistaken for an assignment.
  const updateMatch = normalized.match(
    /update\s+([a-z_]+)\s+set\s+(.*?)(?:\swhere\s|$)/,
  );
  if (updateMatch && ACL_TABLES.includes(updateMatch[1])) {
    const setClause = updateMatch[2];
    for (const col of ACL_COLUMNS) {
      // Require an assignment to avoid flagging references, and word-boundary
      // so principal_id doesn't match as a substring.
      const re = new RegExp(`\\b${col}\\s*=`, "i");
      if (re.test(setClause)) return true;
    }
  }

  return false;
}

describe("assistant-DB ACL write drain guard", () => {
  test("no assistantDbRun/assistantDbExec call writes a dropped ACL column", () => {
    const files = collectSourceFiles(GATEWAY_SRC);
    const violations: string[] = [];

    const callRe = /assistantDb(?:Run|Exec)\s*\(/g;

    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      let m: RegExpExecArray | null;
      callRe.lastIndex = 0;
      while ((m = callRe.exec(src)) !== null) {
        const arg = extractSqlArg(src, m.index);
        if (!arg) continue;
        if (sqlWritesAclColumn(arg.sql)) {
          const rel = file.slice(GATEWAY_SRC.length + 1);
          if (ACL_WRITE_ALLOWLIST.includes(rel)) continue;
          violations.push(`${rel}: ${arg.sql.replace(/\s+/g, " ").trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("matcher flags ACL writes but not info-column or read SQL", () => {
    // ACL writes (must be flagged)
    expect(
      sqlWritesAclColumn("UPDATE contacts SET role = ? WHERE id = ?"),
    ).toBe(true);
    expect(
      sqlWritesAclColumn(
        "UPDATE contact_channels SET status = ?, policy = ? WHERE id = ?",
      ),
    ).toBe(true);
    expect(
      sqlWritesAclColumn(
        "INSERT INTO contacts (id, role, principal_id) VALUES (?, ?, ?)",
      ),
    ).toBe(true);

    // Info-column writes (must NOT be flagged)
    expect(
      sqlWritesAclColumn(
        "UPDATE contact_channels SET last_seen_at = ?, interaction_count = ? WHERE id = ?",
      ),
    ).toBe(false);
    expect(
      sqlWritesAclColumn(
        "INSERT INTO contact_channels (id, last_seen_at, interaction_count, last_interaction) VALUES (?, ?, ?, ?)",
      ),
    ).toBe(false);

    // Identity/info-only writes (must NOT be flagged)
    expect(
      sqlWritesAclColumn(
        "UPDATE contacts SET display_name = ?, updated_at = ? WHERE id = ?",
      ),
    ).toBe(false);

    // Reads referencing ACL columns (must NOT be flagged)
    expect(
      sqlWritesAclColumn(
        "SELECT cc.status FROM contact_channels cc WHERE cc.status = 'active'",
      ),
    ).toBe(false);
  });

  test("allowlist is empty (no sanctioned ACL writes remain)", () => {
    expect(ACL_WRITE_ALLOWLIST).toEqual([]);
    // Guard that INFO_COLUMNS and ACL_COLUMNS stay disjoint.
    expect(
      INFO_COLUMNS.filter((c) =>
        (ACL_COLUMNS as readonly string[]).includes(c),
      ),
    ).toEqual([]);
  });
});
