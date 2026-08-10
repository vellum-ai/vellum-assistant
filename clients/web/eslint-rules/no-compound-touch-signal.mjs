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
 * This rule does not ban the compound, it freezes its population. Existing
 * call sites are listed in `.touch-signal-allowlist.json` while the overlay
 * presentation moves into the design library (LUM-3177), at which point most
 * of them stop asking the question at all. That file shrinks toward zero.
 * Don't add entries by hand: pick the axis the surface actually needs.
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

export const noCompoundTouchSignal = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow new call sites reading the narrow-AND-coarse compound signal.",
    },
    schema: [],
    messages: {
      compoundSignal:
        "'{{name}}' is the narrow-AND-coarse compound, not the input axis. " +
        "Ask what the other branch does under a thumb: if it is hover-only it " +
        "is unusable at every width, so read isPointerCoarse() from " +
        "'@/utils/pointer' instead. Use useIsMobile() if the question is " +
        "really about room. The compound is only right when both halves " +
        "genuinely matter (a sheet that wants a thumb AND a window too narrow " +
        "to anchor in). See docs/PLATFORM_ADAPTATION.md.",
    },
  },
  create(context) {
    const filePath = context.filename ?? context.getFilename();
    const key = relKey(filePath);

    // The module that defines the compound is exempt from its own rule, as
    // are its colocated test and story.
    const ownBase = path
      .basename(key)
      .replace(/\.(test|stories)\.[jt]sx?$/, "")
      .replace(/\.[jt]sx?$/, "");
    if (ownBase === COMPOUND_MODULE) {
      return {};
    }

    const allowlist = loadAllowlist();
    if (Object.hasOwn(allowlist, key)) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        if (!isCompoundModule(node.source.value)) {
          return;
        }
        for (const specifier of node.specifiers) {
          const name =
            specifier.type === "ImportSpecifier"
              ? specifier.imported.name
              : specifier.local.name;
          if (
            specifier.type !== "ImportSpecifier" ||
            COMPOUND_EXPORTS.has(name)
          ) {
            context.report({
              node: specifier,
              messageId: "compoundSignal",
              data: { name },
            });
          }
        }
      },
    };
  },
};
