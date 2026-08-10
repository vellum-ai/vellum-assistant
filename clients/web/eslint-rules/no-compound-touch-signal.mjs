/**
 * Custom ESLint rule: no-compound-touch-signal.
 *
 * `useTouchMobile()` is a compound of two independent axes: a narrow viewport
 * AND a coarse pointer. `docs/PLATFORM_ADAPTATION.md` is explicit that those
 * axes do not imply each other, and the compound is only correct when both
 * halves genuinely matter. Every call site has to re-derive that, the answer
 * is a bare boolean, and nothing catches a wrong one: not the type, not a
 * test (the failing combination is roomy AND coarse, which nobody thinks to
 * write), not review.
 *
 * The failure is not hypothetical. `ContextWindowIndicator` forked on the
 * compound while its other branch was a hover-revealed tooltip, so every
 * touch device wider than 767px got a control with no hover to reveal it and
 * no tap path to open it: a tablet in either orientation, a phone in
 * landscape, an Android tablet (LUM-3197).
 *
 * The discriminator, when you think you want the compound: **ask what the
 * other branch does under a thumb.** An anchored popover still works, just
 * less comfortably on a small screen, so the compound is defensible. A
 * hover-only surface does not work at all, so the size half cannot matter and
 * the call site wants `isPointerCoarse()` from `@/utils/pointer`.
 *
 * This rule does not ban the compound, it freezes its population. It counts
 * *usages*, not files: `.touch-signal-allowlist.json` records how many
 * references each grandfathered file is permitted, so an allow-listed file
 * cannot quietly grow a second narrow-plus-coarse branch. The list shrinks as
 * overlay presentation moves into the design library (LUM-3177), at which
 * point most of these sites stop asking the question at all. Don't add
 * entries by hand: pick the axis the surface actually needs.
 *
 * `scripts/audit-touch-signal-allowlist.mjs` re-runs this rule with
 * `ignoreAllowlist` to recount, so there is exactly one definition of "uses
 * the compound" and the script cannot drift from the rule.
 *
 * See `clients/web/docs/PLATFORM_ADAPTATION.md` → "Three axes, not one
 * boolean".
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { WEB_ROOT } from "./cross-domain-matchers.mjs";

const ALLOWLIST_PATH = path.join(WEB_ROOT, ".touch-signal-allowlist.json");

/** Module whose exports carry the compound signal, by basename. */
const COMPOUND_MODULE = "use-touch-mobile";

/** Exports that hand a caller the ANDed answer. */
const COMPOUND_EXPORTS = new Set([
  "useTouchMobile",
  "TOUCH_MOBILE_MEDIA_QUERY",
]);

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

/**
 * True when an import source points at the compound module, whether by alias
 * (`@/hooks/use-touch-mobile`) or relatively (`./use-touch-mobile`), with or
 * without an extension.
 */
function isCompoundModule(source) {
  if (typeof source !== "string") {
    return false;
  }
  const base = path.posix.basename(source).replace(/\.(ts|tsx|js|jsx)$/, "");
  return base === COMPOUND_MODULE;
}

/** True for the compound module itself, plus its colocated test and story. */
function isOwnModule(key) {
  const base = path
    .basename(key)
    .replace(/\.(test|stories)\.[jt]sx?$/, "")
    .replace(/\.[jt]sx?$/, "");
  return base === COMPOUND_MODULE;
}

export const noCompoundTouchSignal = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Freeze the population of call sites reading the narrow-AND-coarse compound signal.",
    },
    schema: [
      {
        type: "object",
        properties: {
          // Used by scripts/audit-touch-signal-allowlist.mjs to recount the
          // real population without the allow-list suppressing it.
          ignoreAllowlist: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      compoundSignal:
        "'{{name}}' is the narrow-AND-coarse compound, not the input axis. " +
        "Ask what the other branch does under a thumb: if it is hover-only it " +
        "is unusable at every width, so read isPointerCoarse() from " +
        "'@/utils/pointer' instead. Use useIsMobile() if the question is " +
        "really about room. The compound is only right when both halves " +
        "genuinely matter (a sheet that wants a thumb AND a window too narrow " +
        "to anchor in). See docs/PLATFORM_ADAPTATION.md.",
      extraUsage:
        "This file is grandfathered for {{allowed}} use(s) of the compound " +
        "signal and now has {{actual}}. Don't grow the population: a new " +
        "branch here wants isPointerCoarse() or useIsMobile(). If the whole " +
        "file has genuinely migrated, run 'bun run audit:touch-signal'. " +
        "See docs/PLATFORM_ADAPTATION.md.",
    },
  },
  create(context) {
    const filePath = context.filename ?? context.getFilename();
    const key = relKey(filePath);

    if (isOwnModule(key)) {
      return {};
    }

    const ignoreAllowlist = context.options[0]?.ignoreAllowlist === true;
    const entry = ignoreAllowlist ? undefined : loadAllowlist()[key];
    const allowed = typeof entry?.uses === "number" ? entry.uses : 0;

    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      ImportDeclaration(node) {
        if (!isCompoundModule(node.source.value)) {
          return;
        }

        // Every reference to a binding this import introduces, which is the
        // usage count. A file with one import and three branches counts 3.
        const references = sourceCode
          .getDeclaredVariables(node)
          .flatMap((variable) => variable.references);

        const relevant = node.specifiers.filter(
          (specifier) =>
            specifier.type !== "ImportSpecifier" ||
            COMPOUND_EXPORTS.has(specifier.imported.name),
        );
        if (relevant.length === 0) {
          return;
        }

        // Recount mode: one message per reference, so the audit script's
        // message count is the usage count and shares the budget's unit.
        if (ignoreAllowlist) {
          for (const reference of references) {
            context.report({
              node: reference.identifier,
              messageId: "compoundSignal",
              data: { name: reference.identifier.name },
            });
          }
          return;
        }

        if (allowed === 0) {
          for (const specifier of relevant) {
            context.report({
              node: specifier,
              messageId: "compoundSignal",
              data: { name: specifier.local.name },
            });
          }
          return;
        }

        // Grandfathered: permitted up to `allowed` references. Report each
        // one beyond the budget, at the reference rather than the import, so
        // the error points at the new branch.
        const excess = references.slice(allowed);
        for (const reference of excess) {
          context.report({
            node: reference.identifier,
            messageId: "extraUsage",
            data: { allowed, actual: references.length },
          });
        }
      },
    };
  },
};

export const TOUCH_SIGNAL_ALLOWLIST_PATH = ALLOWLIST_PATH;
