/**
 * Custom ESLint rule: no-cross-domain-imports.
 *
 * Disallows imports of the form `@/domains/<y>/...` inside files
 * under `apps/web/src/domains/<x>/...` when `x !== y`. Also catches
 * the equivalent barrel form (`@/domains/<y>`) and relative paths
 * that resolve into a different domain (`../../<y>/foo`). The
 * premise is documented in `apps/web/docs/CONVENTIONS.md` →
 * "Top-level shared directories": code consumed by two or more
 * domains should live at a top-level shared dir (`hooks/`,
 * `stores/`, `utils/`, `types/`, `components/`), not be imported
 * peer-to-peer between domain folders.
 *
 * Existing violations are quarantined in
 * `.cross-domain-allowlist.json` during the LUM-1753 migration.
 * To regenerate after fixing a violation:
 *
 *   bun run audit:cross-domain
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

import {
  ownDomainFor,
  targetDomainFor,
  WEB_ROOT,
} from "./cross-domain-matchers.mjs";

const ALLOWLIST_PATH = path.join(WEB_ROOT, ".cross-domain-allowlist.json");

let allowlistCache = null;
function loadAllowlist() {
  if (allowlistCache === null) {
    allowlistCache = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  }
  return allowlistCache;
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
      const target = targetDomainFor(source, filePath);
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
      // TypeScript inline type imports: `type T = import("@/domains/x/y").Z`.
      // Distinct AST node from `ImportExpression` (which is the runtime
      // dynamic-import form) — @typescript-eslint emits this for the
      // type-position variant.
      TSImportType(node) {
        const arg = node.argument;
        if (arg?.type === "Literal" && typeof arg.value === "string") {
          check(node, arg.value);
        } else if (
          arg?.type === "TSLiteralType" &&
          arg.literal?.type === "Literal" &&
          typeof arg.literal.value === "string"
        ) {
          check(node, arg.literal.value);
        }
      },
    };
  },
};
