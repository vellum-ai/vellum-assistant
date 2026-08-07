/**
 * Custom ESLint rule: no-untranslated-strings.
 *
 * User-facing copy belongs in a catalog under `src/i18n/locales/`, reached
 * through `t()`. A string literal baked into a component is invisible to
 * translators, cannot pluralize outside English, and silently reverts a screen
 * to English-only the moment someone edits it.
 *
 * This rule is scoped, not global. `eslint.config.mjs` enables it only for the
 * paths listed in `i18nEnforcedPaths`, which grows as areas are converted.
 * That is deliberate: switched on repo-wide it would report thousands of
 * pre-existing literals at once, and a rule that noisy gets disabled rather
 * than obeyed. Scoped, a converted area cannot regress, and the list doubles as
 * the record of how far the cutover has reached.
 *
 * What it reports:
 * - JSX text children that contain a word character
 * - string literals passed to any prop that is not structural, when the value
 *   reads as copy rather than an enum ({@link looksLikeCopy})
 * - strings passed to `toast.*()`
 *
 * What it deliberately ignores, because false positives are what get a rule
 * turned off:
 * - text with no word characters (punctuation, separators, digits, symbols)
 * - structural props (`className`, `id`, `href`, `data-*`, handlers)
 * - enum-ish prop values (`variant="primary"`, `tone="error"`)
 * - anything already inside a `t()` call
 * - test and story files, whose fixtures are not shipped copy
 *
 * Escape hatch, for copy that genuinely must not be translated (brand names,
 * code identifiers, protocol tokens):
 *
 *   // eslint-disable-next-line local/no-untranslated-strings -- brand name
 *
 * See `clients/web/docs/I18N.md` for how to add a string properly.
 */

/**
 * Props that carry structure rather than copy. Everything else is treated as
 * potentially user-facing.
 *
 * The allowlist this replaced could only ever catch props someone had thought
 * to add, and a converted domain kept shipping English through `submitLabel`,
 * `toggleAriaLabel`, `disconnectMessage`, and friends. Denying the structural
 * names instead means a new prop is covered by default, which is the safer
 * direction to be wrong in.
 */
const STRUCTURAL_PROPS = new Set([
  "accept",
  // SVG geometry and paint. `d="M17 28.5L24.5 36"` has spaces and a capital
  // first letter, so it reads as copy to `looksLikeCopy` without this.
  "clipPath",
  "d",
  "fill",
  "points",
  "stroke",
  "transform",
  "viewBox",
  "as",
  "autoComplete",
  "charSet",
  "className",
  "htmlFor",
  "href",
  "i18nKey",
  "id",
  "inputMode",
  "key",
  "method",
  "name",
  "ns",
  "pattern",
  "rel",
  "role",
  "src",
  "style",
  "target",
  "testId",
  "to",
  "type",
]);

/** True for props that never hold copy: structural names, `data-*`, handlers. */
function isStructuralProp(name) {
  return (
    STRUCTURAL_PROPS.has(name) ||
    name.startsWith("data-") ||
    name.startsWith("on")
  );
}

/**
 * Whether a string reads as copy rather than an enum value.
 *
 * Prop values split cleanly in practice: copy has spaces ("Save changes") or is
 * a capitalized word ("Delete"), while enum-ish values are lowercase single
 * tokens (`primary`, `error`, `compact`, `dangerOutline`). Judging the value
 * rather than the prop name is what lets `value` be covered at all: it holds
 * `"Not used for workflow runs"` in one place and `"public"` in another.
 */
function looksLikeCopy(text) {
  const trimmed = text.trim();
  if (!isTranslatable(trimmed)) {
    return false;
  }
  return trimmed.includes(" ") || /^\p{Lu}/u.test(trimmed);
}

/** Files whose strings are fixtures rather than shipped copy. */
const EXEMPT_FILE_PATTERN = /\.(test|spec|stories)\.[cm]?[jt]sx?$/;

/** Text with no letters carries no translatable content. */
function isTranslatable(text) {
  return /\p{Letter}/u.test(text);
}

/**
 * True when `node` is inside a `<Trans>` element.
 *
 * `<Trans>` takes its default copy as children so that inline markup survives
 * translation, so its text is already under i18n control and reporting it would
 * make the one correct way to write a linked or bolded sentence unusable.
 *
 * Reference: https://react.i18next.com/latest/trans-component
 */
function insideTransElement(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== "JSXElement") {
      continue;
    }
    const name = current.openingElement?.name;
    if (name?.type === "JSXIdentifier" && name.name === "Trans") {
      return true;
    }
  }
  return false;
}

/** True when `node` sits anywhere inside a `t(...)` / `i18n.t(...)` call. */
function insideTranslationCall(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== "CallExpression") {
      continue;
    }
    const callee = current.callee;
    if (callee.type === "Identifier" && callee.name === "t") {
      return true;
    }
    if (
      callee.type === "MemberExpression" &&
      callee.property.type === "Identifier" &&
      callee.property.name === "t"
    ) {
      return true;
    }
  }
  return false;
}

/** True for `toast(...)` and `toast.error(...)` and friends. */
function isToastCall(callee) {
  if (callee.type === "Identifier") {
    return callee.name === "toast";
  }
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "toast"
  );
}

export const noUntranslatedStrings = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require user-facing copy to come from a translation catalog via t().",
    },
    schema: [],
    messages: {
      jsxText:
        'Untranslated copy: "{{text}}". Move it to a catalog under ' +
        "src/i18n/locales/ and read it with t(). See docs/I18N.md.",
      prop:
        'Untranslated copy in the `{{prop}}` prop: "{{text}}". Move it to a ' +
        "catalog under src/i18n/locales/ and read it with t(). See docs/I18N.md.",
      toast:
        'Untranslated toast copy: "{{text}}". Move it to a catalog under ' +
        "src/i18n/locales/ and read it with t(). See docs/I18N.md.",
    },
  },
  create(context) {
    const filePath = context.filename ?? context.getFilename();
    if (EXEMPT_FILE_PATTERN.test(filePath)) {
      return {};
    }

    /** Truncated for the message, so a long paragraph stays readable. */
    const preview = (text) => {
      const collapsed = text.trim().replace(/\s+/g, " ");
      return collapsed.length > 40 ? `${collapsed.slice(0, 40)}...` : collapsed;
    };

    /**
     * Report a string-bearing expression. Template literals are checked by
     * their static parts: a template whose only text is punctuation (a path
     * being assembled, say) carries no copy, while one with words in it is a
     * sentence built by concatenation, which is the shape that cannot be
     * translated at all.
     */
    function checkExpression(node, messageId, data, isCopy = isTranslatable) {
      if (!node) {
        return;
      }
      if (node.type === "Literal" && typeof node.value === "string") {
        if (isCopy(node.value)) {
          context.report({
            node,
            messageId,
            data: { ...data, text: preview(node.value) },
          });
        }
        return;
      }
      if (node.type === "TemplateLiteral") {
        const statics = node.quasis.map((q) => q.value.cooked ?? "").join(" ");
        if (isCopy(statics)) {
          context.report({
            node,
            messageId,
            data: { ...data, text: preview(statics) },
          });
        }
        return;
      }
      // `cond ? "Open" : "Close"` and `label || "Untitled"` are copy chosen in
      // the component. Picking a string in TypeScript is the same problem as
      // writing one there: the choice belongs in the catalog, where a
      // translator can see both branches.
      if (node.type === "ConditionalExpression") {
        checkExpression(node.consequent, messageId, data, isCopy);
        checkExpression(node.alternate, messageId, data, isCopy);
        return;
      }
      if (node.type === "LogicalExpression") {
        checkExpression(node.right, messageId, data, isCopy);
      }
    }

    return {
      JSXText(node) {
        if (!isTranslatable(node.value) || insideTransElement(node)) {
          return;
        }
        context.report({
          node,
          messageId: "jsxText",
          data: { text: preview(node.value) },
        });
      },

      // `<p>{`Use ${name} for all schedules`}</p>` and `<p>{"Done"}</p>` are
      // copy rendered as an element's child, but neither is `JSXText`, so they
      // need their own visit. The template form is the more important of the
      // two: it is a sentence assembled in the component, which no translator
      // can reorder.
      JSXExpressionContainer(node) {
        const parent = node.parent;
        if (parent?.type !== "JSXElement" && parent?.type !== "JSXFragment") {
          // An attribute value, handled by `JSXAttribute` against the list of
          // props that actually reach a user.
          return;
        }
        if (insideTransElement(node)) {
          return;
        }
        checkExpression(node.expression, "jsxText", {});
      },

      JSXAttribute(node) {
        const name =
          node.name.type === "JSXIdentifier" ? node.name.name : undefined;
        if (!name || isStructuralProp(name) || !node.value) {
          return;
        }

        // `prop="text"` is a Literal directly on the attribute;
        // `prop={...}` wraps the value in a JSXExpressionContainer.
        const value =
          node.value.type === "JSXExpressionContainer"
            ? node.value.expression
            : node.value;
        if (insideTranslationCall(value)) {
          return;
        }
        checkExpression(value, "prop", { prop: name }, looksLikeCopy);
      },

      CallExpression(node) {
        if (!isToastCall(node.callee)) {
          return;
        }
        const [first] = node.arguments;
        if (!first || insideTranslationCall(first)) {
          return;
        }
        checkExpression(first, "toast", {});
      },
    };
  },
};
