/**
 * Custom ESLint rule: no-cross-domain-imports.
 *
 * Disallows imports of the form `@/domains/<y>/...` inside files
 * under `apps/web/src/domains/<x>/...` when `x !== y`. The premise
 * is documented in `apps/web/CONVENTIONS.md` → "Top-level shared
 * directories" — code consumed by two or more domains should live
 * at a top-level shared dir (`hooks/`, `stores/`, `utils/`,
 * `types/`, `components/`), not be imported peer-to-peer between
 * domain folders.
 *
 * Existing violations are quarantined in `.cross-domain-allowlist.json`
 * during the LUM-1753 migration. To regenerate after fixing a
 * violation:
 *
 *   node apps/web/scripts/audit-cross-domain-imports.mjs
 *
 * Cleanup PRs should shrink the allow-list monotonically toward
 * zero. Don't add new entries by hand — fix the import instead.
 *
 * References:
 *   - bulletproof-react: https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md
 *   - Feature-Sliced Design: https://feature-sliced.design/docs/guides/issues/cross-imports
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");
const ALLOWLIST_PATH = path.join(WEB_ROOT, ".cross-domain-allowlist.json");
const DOMAINS_DIR = path.join(WEB_ROOT, "src/domains");

/** Lazy-load + cache the allow-list. */
let allowlistCache = null;
function loadAllowlist() {
  if (allowlistCache === null) {
    allowlistCache = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  }
  return allowlistCache;
}

/** Extract the owning domain segment for a file path, or null. */
function ownDomainFor(filePath) {
  const rel = path.relative(DOMAINS_DIR, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const [first] = rel.split(path.sep);
  return first || null;
}

/** Extract the target domain from an import source, or null. */
function targetDomainFor(source) {
  const m = /^@\/domains\/([^/]+)\//.exec(source);
  return m ? m[1] : null;
}

/** Posix-style file path relative to WEB_ROOT (matches allow-list keys). */
function relKey(filePath) {
  return path.relative(WEB_ROOT, filePath).split(path.sep).join("/");
}

export const noCrossDomainImports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow cross-domain imports between apps/web/src/domains/<x>/ peers.",
    },
    schema: [],
    messages: {
      crossDomain:
        "Cross-domain import: '{{owner}}' should not import from '{{target}}'. " +
        "Lift the shared code to a top-level dir (hooks/, stores/, utils/, " +
        "types/, components/), or compose at the page level. See CONVENTIONS.md " +
        "→ 'Top-level shared directories'.",
    },
  },
  create(context) {
    const filePath = context.filename ?? context.getFilename();
    const owner = ownDomainFor(filePath);
    if (!owner) return {};

    const allowlist = loadAllowlist();
    const allowedTargets = new Set(allowlist[relKey(filePath)] ?? []);

    function check(node, source) {
      if (typeof source !== "string") return;
      const target = targetDomainFor(source);
      if (!target || target === owner) return;
      if (allowedTargets.has(target)) return;
      context.report({
        node,
        messageId: "crossDomain",
        data: { owner, target },
      });
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
    };
  },
};
