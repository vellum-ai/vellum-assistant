/**
 * Custom ESLint rule: no-cross-domain-imports.
 *
 * Each folder under `apps/web/src/domains/` is meant to be a
 * self-contained feature area. When one feature imports directly
 * from another's internals, you create a hidden coupling that
 * makes the codebase harder to reason about and refactor — change
 * the source feature, break the consumer. The fix is to lift
 * shared code up to a top-level dir (`hooks/`, `stores/`,
 * `utils/`, `types/`, `components/`) so the dependency is
 * explicit and one-directional, or compose at the page/route
 * level.
 *
 * This rule fails CI on any cross-domain import: `@/domains/<y>/`
 * or `@/domains/<y>` (barrel) or a relative `../../<y>/...` path
 * inside a file under `src/domains/<x>/...` when `x !== y`.
 *
 * Existing legacy imports are listed in
 * `.cross-domain-allowlist.json` while we lift them up. That
 * file shrinks toward zero over time. Don't add new entries by
 * hand — fix the import instead. After removing one:
 *
 *   bun run audit:cross-domain
 *
 * See `apps/web/docs/CONVENTIONS.md` → "How to decide where the
 * domain split is" for the full reasoning.
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
