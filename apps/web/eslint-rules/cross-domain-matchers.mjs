/**
 * Shared helpers for the cross-domain-imports rule and the audit
 * script. Centralized so the lint gate and the snapshot generator
 * can never drift apart — if you add a new import form here, both
 * consumers pick it up.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(__dirname, "..");
export const DOMAINS_DIR = path.join(WEB_ROOT, "src/domains");

/**
 * Owning domain for a file path (the `<x>` segment in
 * `src/domains/<x>/...`), or `null` if the file is not inside a
 * domain folder.
 */
export function ownDomainFor(filePath) {
  const rel = path.relative(DOMAINS_DIR, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const [first] = rel.split(path.sep);
  return first || null;
}

/**
 * Resolve a module-specifier `source` (as it appears in an import
 * statement) to the owning domain it imports from, or `null` if
 * the source does not resolve to a `src/domains/<x>/` location.
 *
 * Handles:
 *   - alias subpath:   `@/domains/<x>/foo.js`
 *   - alias barrel:    `@/domains/<x>` (no trailing slash)
 *   - relative path:   `../../<x>/foo.js` (resolved against importer)
 *
 * `importerFile` is required for relative-path resolution; pass
 * the absolute path of the file containing the import.
 */
export function targetDomainFor(source, importerFile) {
  if (typeof source !== "string") return null;

  const alias = /^@\/domains\/([^/]+)(?:\/|$)/.exec(source);
  if (alias) return alias[1];

  if (source.startsWith(".") && importerFile) {
    const resolved = path.resolve(path.dirname(importerFile), source);
    const rel = path.relative(DOMAINS_DIR, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const [first] = rel.split(path.sep);
    return first || null;
  }

  return null;
}

/**
 * Regex capturing the module source from every import-like form
 * we need to scan in raw text (audit script). The captured group
 * is the specifier between the quotes. The lint rule does not
 * need this — it visits AST nodes directly.
 *
 * Forms covered:
 *   - `import x from "..."`
 *   - `import "..."` (side-effect)
 *   - `import("...")` (dynamic, including inline type imports)
 *   - `export ... from "..."`
 *   - `export * from "..."`
 *
 * Note: this is intentionally permissive — false positives only
 * cause harmless allow-list bloat (the rule won't fire on
 * non-imports), while false negatives let real violations slip
 * past the audit.
 */
export const IMPORT_SOURCE_RE =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
