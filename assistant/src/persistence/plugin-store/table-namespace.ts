/**
 * Table-namespace enforcement for the plugin-owned durable store.
 *
 * Every plugin gets a fixed table-name prefix derived from its host id; the
 * store facet rejects any statement that references a table outside that
 * prefix, so one plugin can never read or write another plugin's tables or the
 * core schema. This module owns the prefix derivation and the statement
 * validation.
 */

/**
 * Fixed prefix for every plugin-owned table. A plugin's tables all live under
 * `plugin_<id>_…` in the shared database. Kept in sync with the vector-store
 * collection prefix (`pluginCollectionName`) so the two namespaces read alike.
 */
export function pluginTablePrefix(hostId: string): string {
  return `plugin_${sanitizeHostId(hostId)}_`;
}

/**
 * Reduce a host id to the `[a-z0-9_]` alphabet so it can sit inside a SQL
 * identifier without quoting. Plugin ids are kebab/dot-cased package names
 * (`vellum-memory`, `@scope/pkg`); collapse every other character to `_`.
 */
export function sanitizeHostId(hostId: string): string {
  return hostId.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/**
 * Identifiers appearing immediately after one of these keywords name a table
 * the statement reads or writes. We require each such identifier to carry the
 * plugin's prefix. This is deliberately conservative: a statement the matcher
 * cannot understand (a table reference in a form we do not key off) simply
 * does not contribute a validated table, but any keyword-introduced table that
 * lacks the prefix is rejected.
 */
const TABLE_INTRODUCING_KEYWORDS = ["from", "join", "into", "update", "table"];

/**
 * Strip string/blob literals and SQL comments so identifiers inside them are
 * not mistaken for table references. Replaces each with a single space to keep
 * token boundaries intact.
 */
function stripLiteralsAndComments(sql: string): string {
  return (
    sql
      // single-quoted strings (with '' escapes)
      .replace(/'(?:[^']|'')*'/g, " ")
      // double-quoted identifiers — kept as a literal blank so a quoted table
      // name cannot smuggle an unprefixed reference past the matcher
      .replace(/"(?:[^"]|"")*"/g, " ")
      // bracket / backtick quoted identifiers
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/`[^`]*`/g, " ")
      // line comments
      .replace(/--[^\n]*/g, " ")
      // block comments
      .replace(/\/\*[\s\S]*?\*\//g, " ")
  );
}

/**
 * Collect the table identifiers a statement references via a recognized
 * table-introducing keyword. Schema-qualified names (`main.foo`) collapse to
 * their final segment, which is the table name the prefix applies to.
 */
function referencedTables(sql: string): string[] {
  const cleaned = stripLiteralsAndComments(sql);
  const tables: string[] = [];
  const re =
    /\b(from|join|into|update|table)\s+(?:if\s+not\s+exists\s+)?(?:if\s+exists\s+)?([a-zA-Z_][a-zA-Z0-9_.]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned)) !== null) {
    const keyword = match[1]?.toLowerCase();
    if (!keyword || !TABLE_INTRODUCING_KEYWORDS.includes(keyword)) continue;
    const ref = match[2];
    if (!ref) continue;
    // `main.plugin_foo_bar` → `plugin_foo_bar`.
    const name = ref.split(".").pop() as string;
    tables.push(name.toLowerCase());
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
 * namespace. A statement that references no recognizable table (e.g. `PRAGMA`,
 * `BEGIN`) passes — it cannot reach another plugin's rows — but any
 * keyword-introduced table lacking the prefix is rejected.
 */
export function assertScopedToPlugin(hostId: string, sql: string): void {
  const prefix = pluginTablePrefix(hostId);
  for (const table of referencedTables(sql)) {
    if (!table.startsWith(prefix)) {
      throw new PluginStoreNamespaceError(hostId, table, prefix);
    }
  }
}
