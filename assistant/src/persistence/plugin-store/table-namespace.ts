/**
 * Table-namespace enforcement for the plugin-owned durable store.
 *
 * Every plugin gets a fixed table-name prefix derived from its host id; the
 * store facet rejects any statement that references a table outside that
 * prefix, so one plugin can never read or write another plugin's tables or the
 * core schema. This module owns the prefix derivation and the statement
 * validation.
 */

import { createHash } from "node:crypto";

/**
 * Fixed prefix for every plugin-owned table. A plugin's tables all live under
 * `plugin_<sanitized>_<hash>_…` in the shared database, where `<sanitized>` is
 * the host id reduced to the SQL-identifier alphabet and `<hash>` is a short
 * digest of the UNSANITIZED id.
 *
 * The hash makes the prefix injective: sanitizing alone is lossy (`foo-bar`,
 * `foo_bar`, and `foo.bar` all reduce to `foo_bar`), so two distinct plugins
 * with colliding sanitized names would otherwise share a prefix — and since
 * {@link assertScopedToPlugin} authorizes solely by prefix, they could read and
 * write each other's tables. Folding the raw id into the prefix keeps distinct
 * plugins in distinct namespaces even when their sanitized forms collide.
 */
export function pluginTablePrefix(hostId: string): string {
  return `plugin_${sanitizeHostId(hostId)}_${hostIdHash(hostId)}_`;
}

/**
 * Reduce a host id to the `[a-z0-9_]` alphabet so it can sit inside a SQL
 * identifier without quoting. Plugin ids are kebab/dot-cased package names
 * (`vellum-memory`, `@scope/pkg`); collapse every other character to `_`.
 *
 * Lossy by design (distinct ids can share a sanitized form) — injectivity of
 * the table prefix is restored by {@link hostIdHash}, not by this function.
 */
export function sanitizeHostId(hostId: string): string {
  return hostId.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/**
 * Short, stable hex digest of the raw (unsanitized) host id. Appended to the
 * table prefix so distinct raw ids yield distinct prefixes even when their
 * sanitized forms collide. Hex is already within the SQL-identifier alphabet,
 * so the prefix stays unquoted-safe. Twelve hex chars (48 bits) make an
 * accidental collision across a handful of co-installed plugins negligible.
 */
function hostIdHash(hostId: string): string {
  return createHash("sha256").update(hostId).digest("hex").slice(0, 12);
}

/**
 * Identifiers appearing immediately after one of these keywords name a table
 * the statement reads or writes. We require each such identifier to carry the
 * plugin's prefix. Any keyword-introduced table that lacks the prefix is
 * rejected.
 *
 * `on` is deliberately NOT here: it follows a `CREATE INDEX … ON <table>` (a
 * table target — captured specially, see {@link captureCreateIndexOrTriggerTarget})
 * but also a `JOIN … ON <predicate>` (a column expression, not a table). The
 * walk keys off `on` only inside a CREATE INDEX/TRIGGER, never in a join.
 */
const TABLE_INTRODUCING_KEYWORDS = new Set([
  "from",
  "join",
  "into",
  "update",
  "table",
]);

/**
 * Keywords that end a comma-separated table list. After a table-introducing
 * keyword names its first table, a comma continues the list (multi-table
 * `FROM a, b`); any of these keywords closes it so commas in a trailing column
 * list, predicate, or clause are not mistaken for additional table references.
 */
const TABLE_LIST_TERMINATORS = new Set([
  "where",
  "on",
  "using",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "window",
  "returning",
  "set",
  "values",
  "select",
  "union",
  "intersect",
  "except",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "natural",
]);

/**
 * A lexed SQL token. `kind` distinguishes a bareword (keyword or unquoted
 * identifier) from a quoted identifier and from structural punctuation. A
 * quoted identifier (`"messages"`, `` `messages` ``, `[messages]`) CAN name a
 * table, so the walk validates its inner name — distinct from a single-quoted
 * string literal, which is a value (never a table) and is dropped during lexing.
 */
interface SqlToken {
  /** `word` — bareword keyword/identifier; `quoted` — quoted identifier; `punct` — single punctuation char. */
  kind: "word" | "quoted" | "punct";
  /** For `quoted`, the inner text with surrounding quotes removed; otherwise the raw token text. */
  value: string;
}

/**
 * Scan a quoted run that doubles its quote char to escape it (`"a""b"`,
 * `` `a``b` ``). `start` indexes the opening quote; returns the recovered inner
 * text and the index just past the closing quote. An unterminated run consumes
 * to end-of-input.
 */
function scanDoubledQuote(
  sql: string,
  start: number,
  quote: string,
): { inner: string; next: number } {
  const n = sql.length;
  let i = start + 1;
  let inner = "";
  while (i < n) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        inner += quote;
        i += 2;
        continue;
      }
      i++;
      break;
    }
    inner += sql[i];
    i++;
  }
  return { inner, next: i };
}

/**
 * Lex `sql` into the tokens the table-reference walk needs: barewords, quoted
 * identifiers (double-quote / backtick / bracket, with inner text recovered),
 * and the single punctuation characters that delimit clauses (`,` `(` `)` `;`).
 *
 * String literals (`'...'`, with `''` escapes) and comments are consumed and
 * dropped — a literal is a value, not a table, so it must never surface as a
 * token the walk could read as a table name. Everything else (operators,
 * whitespace) is skipped.
 */
function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i] as string;

    // Single-quoted string literal — a VALUE, not a table. Consume through the
    // closing quote (handling the `''` escape) and emit nothing.
    if (ch === "'") {
      i = scanDoubledQuote(sql, i, "'").next;
      continue;
    }

    // Double-quoted (standard SQL) or backtick-quoted (MySQL) identifier, each
    // with a doubled-quote escape. A quoted identifier CAN name a table, so
    // recover the inner text and emit it.
    if (ch === '"' || ch === "`") {
      const { inner, next } = scanDoubledQuote(sql, i, ch);
      tokens.push({ kind: "quoted", value: inner });
      i = next;
      continue;
    }

    // Bracket-quoted identifier (T-SQL style). No escaping inside brackets.
    if (ch === "[") {
      i++;
      let inner = "";
      while (i < n && sql[i] !== "]") {
        inner += sql[i];
        i++;
      }
      i++; // consume closing ]
      tokens.push({ kind: "quoted", value: inner });
      continue;
    }

    // Line comment.
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }

    // Block comment.
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Bareword: keyword or unquoted identifier. Allow `.` so schema-qualified
    // names (`main.foo`) stay one token; the walk takes the final segment.
    if (/[A-Za-z_]/.test(ch)) {
      let word = "";
      while (i < n && /[A-Za-z0-9_.$]/.test(sql[i] as string)) {
        word += sql[i];
        i++;
      }
      tokens.push({ kind: "word", value: word });
      continue;
    }

    // Punctuation we care about for clause/structure boundaries.
    if (ch === "," || ch === "(" || ch === ")" || ch === ";") {
      tokens.push({ kind: "punct", value: ch });
      i++;
      continue;
    }

    // Anything else (operators, whitespace) is irrelevant to table refs.
    i++;
  }
  return tokens;
}

/**
 * Reduce a (possibly schema-qualified) table reference to the bare table name
 * the prefix applies to: `main.plugin_foo_bar` → `plugin_foo_bar`. A quoted
 * identifier's inner text is treated whole — quoting suppresses the `.`
 * special-casing — so `"my.table"` stays `my.table`.
 */
function tableNameFromToken(token: SqlToken): string {
  if (token.kind === "quoted") {
    return token.value.toLowerCase();
  }
  return (token.value.split(".").pop() as string).toLowerCase();
}

/**
 * Whether a `word` token is a table-introducing keyword. Quoted tokens are
 * never keywords — `"from"` is an identifier, not the FROM clause.
 */
function isTableIntroKeyword(token: SqlToken): boolean {
  return (
    token.kind === "word" &&
    TABLE_INTRODUCING_KEYWORDS.has(token.value.toLowerCase())
  );
}

/**
 * Modifier words that may sit between a table-introducing keyword and the
 * table name (`CREATE TABLE IF NOT EXISTS foo`, `DROP TABLE IF EXISTS foo`).
 * Skipped so the table name itself is the captured token. (`TEMP`/`TEMPORARY`
 * precede the `TABLE` keyword, so they never need skipping here.)
 */
const INTRODUCER_MODIFIERS = new Set(["if", "not", "exists"]);

/**
 * Capture the table name beginning at `tokens[index]`, returning the resolved
 * name and the index just past it — or `null` when no table name sits there
 * (punctuation, e.g. a `FROM ( subquery`, or end-of-input). Both unquoted and
 * quoted identifiers are captured; a quoted identifier resolves to its inner
 * name, so `FROM "messages"` validates exactly like the bareword form.
 *
 * A schema-qualified name whose table segment is quoted (`main."messages"`)
 * lexes as a trailing-`.` bareword followed by a quoted token — the quoted
 * token is the real table name, so it is taken as the name (not the bareword's
 * empty final segment), keeping the quoted form from slipping the guard.
 */
function captureTableAt(
  tokens: SqlToken[],
  index: number,
): { name: string; next: number } | null {
  const token = tokens[index] as SqlToken | undefined;
  if (!token || token.kind === "punct") return null;
  if (token.kind === "word" && token.value.endsWith(".")) {
    const after = tokens[index + 1] as SqlToken | undefined;
    if (after?.kind === "quoted") {
      return { name: after.value.toLowerCase(), next: index + 2 };
    }
  }
  return { name: tableNameFromToken(token), next: index + 1 };
}

/**
 * Lowercased text of a `word` token, or `null` for a quoted/punct token (which
 * is never a keyword). Used to read the leading verbs that classify a statement.
 */
function keywordAt(tokens: SqlToken[], index: number): string | null {
  const token = tokens[index] as SqlToken | undefined;
  if (!token || token.kind !== "word") return null;
  return token.value.toLowerCase();
}

/**
 * `CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name> ON <table>` and
 * `CREATE [TEMP] TRIGGER [IF NOT EXISTS] <name> … ON <table>` name their target
 * table after the `ON` keyword — a position {@link TABLE_INTRODUCING_KEYWORDS}
 * cannot key off (`on` also opens a join predicate). Given `tokens` starting at
 * the leading `create`, return the captured target table name, or `null` when
 * the statement is not a CREATE INDEX/TRIGGER or has no `ON <table>` shape.
 *
 * Only the first `ON` is taken as the target; a trigger body's later `ON`
 * (inside its action statements) is reached by the independent walk over those
 * statements, not here.
 */
function captureCreateIndexOrTriggerTarget(tokens: SqlToken[]): string | null {
  // tokens[0] is `create`; find the INDEX/TRIGGER keyword, skipping the
  // modifiers SQLite allows between them (`UNIQUE`, `TEMP`/`TEMPORARY`).
  let i = 1;
  while (i < tokens.length) {
    const kw = keywordAt(tokens, i);
    if (kw === "unique" || kw === "temp" || kw === "temporary") {
      i++;
      continue;
    }
    break;
  }
  const kind = keywordAt(tokens, i);
  if (kind !== "index" && kind !== "trigger") return null;

  // Scan forward to the first `ON`; the token after it is the target table.
  for (let j = i + 1; j < tokens.length; j++) {
    if (keywordAt(tokens, j) === "on") {
      const captured = captureTableAt(tokens, j + 1);
      return captured ? captured.name : null;
    }
  }
  return null;
}

/**
 * Leading verbs of statements that structurally operate on a table — so a shape
 * that reaches this function but yields no captured table is an unrecognized
 * form the guard does not understand, and is rejected fail-closed (see
 * {@link assertScopedToPlugin}). `SELECT` is intentionally absent: `SELECT 1`
 * (no FROM) is valid table-less SQL that reaches no table, so a table-less
 * SELECT is allowed rather than rejected.
 */
const TABLE_OPERATING_LEADING_VERBS = new Set([
  "insert",
  "replace",
  "update",
  "delete",
  "alter",
  "drop",
  "truncate",
]);

/**
 * Whether a statement's leading verbs structurally require a table target, so a
 * zero-table capture means an unhandled shape (rejected fail-closed). Covers the
 * single-word verbs in {@link TABLE_OPERATING_LEADING_VERBS} plus the
 * table-bearing `CREATE` forms (`CREATE TABLE`, `CREATE [UNIQUE] INDEX`,
 * `CREATE [TEMP] TRIGGER`). `CREATE VIEW`/`CREATE VIRTUAL TABLE` etc. that do
 * not own a base table are not forced — they reference their backing tables via
 * the keyword walk like any other statement.
 */
function operatesOnTable(tokens: SqlToken[]): boolean {
  const lead = keywordAt(tokens, 0);
  if (lead === null) return false;
  if (TABLE_OPERATING_LEADING_VERBS.has(lead)) return true;
  if (lead === "create") {
    return captureCreateIndexOrTriggerTarget(tokens) !== null
      ? true
      : statementCreatesTable(tokens);
  }
  return false;
}

/**
 * Whether a `CREATE … TABLE` statement (ignoring `TEMP`/`TEMPORARY`) introduces
 * a base table — the `table` keyword is in {@link TABLE_INTRODUCING_KEYWORDS}, so
 * the keyword walk captures its name; this only classifies the shape for the
 * fail-closed check.
 */
function statementCreatesTable(tokens: SqlToken[]): boolean {
  let i = 1;
  while (
    keywordAt(tokens, i) === "temp" ||
    keywordAt(tokens, i) === "temporary"
  ) {
    i++;
  }
  return keywordAt(tokens, i) === "table";
}

/**
 * Collect the table identifiers a statement references via a recognized
 * table-introducing keyword (and the commas continuing a multi-table list),
 * plus the `ON <table>` target of a CREATE INDEX/TRIGGER.
 */
function referencedTables(tokens: SqlToken[]): string[] {
  const tables: string[] = [];

  // CREATE INDEX/TRIGGER name their target after `ON`, a position the keyword
  // walk cannot key off; capture it up front.
  if (keywordAt(tokens, 0) === "create") {
    const target = captureCreateIndexOrTriggerTarget(tokens);
    if (target !== null) tables.push(target);
  }

  let i = 0;
  while (i < tokens.length) {
    if (!isTableIntroKeyword(tokens[i] as SqlToken)) {
      i++;
      continue;
    }
    i++;
    // Skip `IF NOT EXISTS` modifiers between the keyword and the first table.
    while (
      i < tokens.length &&
      (tokens[i] as SqlToken).kind === "word" &&
      INTRODUCER_MODIFIERS.has((tokens[i] as SqlToken).value.toLowerCase())
    ) {
      i++;
    }
    // The first token after the keyword (and any modifiers) names a table. A
    // subquery (`FROM ( SELECT ...`) introduces no direct table here; the inner
    // SELECT's own FROM is matched independently.
    const first = captureTableAt(tokens, i);
    if (!first) continue;
    tables.push(first.name);
    i = first.next;
    // Continue a comma-separated table list (`FROM a, b, c` / `UPDATE a, b`).
    // A clause keyword or any non-comma punctuation ends the list so commas in
    // a later column list or predicate are not read as further tables.
    while (i < tokens.length) {
      const next = tokens[i] as SqlToken;
      if (next.kind === "punct" && next.value === ",") {
        const cand = captureTableAt(tokens, i + 1);
        if (!cand) break;
        tables.push(cand.name);
        i = cand.next;
        continue;
      }
      if (
        next.kind === "word" &&
        TABLE_LIST_TERMINATORS.has(next.value.toLowerCase())
      ) {
        break;
      }
      // An alias, `AS`, or anything else that is not a comma: stop scanning the
      // list (the next table-introducing keyword restarts capture).
      break;
    }
  }
  return tables;
}

/**
 * Error thrown when a plugin statement targets a table outside its namespace.
 */
export class PluginStoreNamespaceError extends Error {
  constructor(
    public readonly hostId: string,
    public readonly table: string,
    public readonly prefix: string,
  ) {
    super(
      `plugin "${hostId}" may only access tables prefixed "${prefix}"; ` +
        `statement references "${table}"`,
    );
    this.name = "PluginStoreNamespaceError";
  }
}

/**
 * Throw if `sql` references any table outside the plugin's `plugin_<id>_`
 * namespace. A statement that operates on no table (e.g. `PRAGMA`, `BEGIN`, a
 * table-less `SELECT 1`) passes — it cannot reach another plugin's rows — but
 * any keyword-introduced table lacking the prefix is rejected, whether named
 * bare (`FROM messages`) or quoted (`FROM "messages"`).
 *
 * Fail-closed: a statement whose leading verbs structurally operate on a table
 * (INSERT/UPDATE/DELETE/REPLACE/ALTER/DROP/TRUNCATE, CREATE TABLE/INDEX/TRIGGER)
 * yet yields no captured table is an unrecognized shape the guard cannot vouch
 * for — it is rejected rather than let through, so a future unhandled DDL form
 * cannot silently bypass the namespace check.
 */
export function assertScopedToPlugin(hostId: string, sql: string): void {
  const prefix = pluginTablePrefix(hostId);
  const tokens = tokenize(sql);
  const tables = referencedTables(tokens);

  if (tables.length === 0) {
    if (operatesOnTable(tokens)) {
      throw new PluginStoreNamespaceError(hostId, "<unrecognized>", prefix);
    }
    return;
  }

  for (const table of tables) {
    if (!table.startsWith(prefix)) {
      throw new PluginStoreNamespaceError(hostId, table, prefix);
    }
  }
}
