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
  "fontFamily",
  "points",
  // SVG fit mode (`xMidYMid meet`) has spaces + capitals, so it reads as
  // copy to `looksLikeCopy` without this.
  "preserveAspectRatio",
  "stroke",
  "transform",
  "viewBox",
  // ARIA relationships hold element ids, not copy: `aria-labelledby` points at
  // the node holding the label rather than spelling one out. This is every
  // attribute WAI-ARIA types as an ID reference or ID reference list.
  "aria-activedescendant",
  "aria-controls",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
  "aria-labelledby",
  "aria-owns",
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
  // Layout-only className wrappers (`w-32 shrink-0`) read as copy to
  // `looksLikeCopy` because of spaces, but they are never user-facing text.
  "wrapperClassName",
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

/**
 * The words a static fragment contributes, once whatever is glued to an
 * interpolation is taken off it.
 *
 * A sentence separates its words, so `${label} actions` keeps "actions" and
 * `${count}-day trial` keeps "trial". An identifier does not separate
 * anything, so `${name}.vellum` and `${id}-opt-${expr}` are left with nothing:
 * a file extension and an id segment are not copy, and neither is the "-day"
 * that a translator would have to leave attached to the number anyway. The
 * ends of the run are free, since nothing is joined there.
 */
function unglue(text, followsExpression, precedesExpression) {
  let words = text;
  if (followsExpression) {
    const boundary = words.search(/\s/);
    words = boundary === -1 ? "" : words.slice(boundary);
  }
  if (precedesExpression) {
    const boundary = words.search(/\s\S*$/);
    words = boundary === -1 ? "" : words.slice(0, boundary + 1);
  }
  return words;
}

/**
 * The fields of a toast's options bag that the toast renders, taken from
 * `ToastOptions` in `packages/design-library/src/components/toast.tsx`, which
 * is the only toast this app has: nothing imports `sonner` directly. The rest
 * of that interface (`id`, `duration`, `tone`, and the `onClick` beside this
 * `label`) is machinery. Add to these when that interface gains copy.
 */
const TOAST_COPY_FIELDS = new Set(["description", "label"]);
const TOAST_COPY_BAGS = new Set(["action"]);

/** The operands of a `+` chain, left to right, with the chain flattened out. */
function flattenConcatenation(node) {
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return [
      ...flattenConcatenation(node.left),
      ...flattenConcatenation(node.right),
    ];
  }
  return [node];
}

/** True for a string written out in the source rather than computed. */
function isStringLiteral(node) {
  return node.type === "Literal" && typeof node.value === "string";
}

/** True for an operand that stands in for a value, the way `${x}` does. */
function isInterpolation(node) {
  return Boolean(node) && node.type !== "Literal";
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
      if (isStringLiteral(node)) {
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
        checkAssembled(
          node,
          node.quasis.map((quasi, index) =>
            unglue(
              quasi.value.cooked ?? "",
              index > 0,
              index < node.quasis.length - 1,
            ),
          ),
          node.expressions,
          messageId,
          data,
          isCopy,
        );
        return;
      }
      // `"Delete " + name` builds its sentence the same way a template does,
      // so it is read the same way. Only `+` builds a string, which leaves the
      // other operators out of it.
      if (node.type === "BinaryExpression" && node.operator === "+") {
        const operands = flattenConcatenation(node);
        checkAssembled(
          node,
          operands.map((operand, index) =>
            isStringLiteral(operand)
              ? unglue(
                  operand.value,
                  isInterpolation(operands[index - 1]),
                  isInterpolation(operands[index + 1]),
                )
              : "",
          ),
          operands.filter(isInterpolation),
          messageId,
          data,
          isCopy,
        );
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

    /**
     * Read a string the component assembles, from its static fragments and
     * the values interleaved between them.
     *
     * Anything with a value in it is judged by `isTranslatable` rather than by
     * `isCopy`: `` `${name} actions` `` leaves "actions" behind, one lowercase
     * word that the prop-value test reads as an enum, while the string it
     * builds is the shape a translator cannot reorder. The values are read in
     * turn, since `${draft ? "Draft" : "Live"}` puts its copy in the one place
     * the fragments are not.
     */
    function checkAssembled(node, fragments, values, messageId, data, isCopy) {
      const statics = fragments.join(" ");
      if (values.length > 0 ? isTranslatable(statics) : isCopy(statics)) {
        context.report({
          node,
          messageId,
          data: { ...data, text: preview(statics) },
        });
      }
      for (const value of values) {
        checkExpression(value, messageId, data, isCopy);
      }
    }

    /**
     * The copy in a toast's options bag: the fields the toast renders, and the
     * nested `action` / `cancel` bags that carry a label of their own. Keyed
     * rather than walked, because the same object holds a toast id, durations,
     * placement and callbacks, none of which a translator has any use for.
     *
     * These are judged as copy on sight rather than through the prop-value
     * test: `description: "saved"` is one lowercase word, which that test
     * reads as an enum value, and a toast renders it to the user regardless.
     */
    function checkToastOptions(node) {
      for (const property of node.properties) {
        if (property.type !== "Property" || property.computed) {
          continue;
        }
        const key =
          property.key.type === "Identifier"
            ? property.key.name
            : property.key.type === "Literal"
              ? String(property.key.value)
              : undefined;
        if (!key) {
          continue;
        }
        if (
          TOAST_COPY_BAGS.has(key) &&
          property.value.type === "ObjectExpression"
        ) {
          checkToastOptions(property.value);
          continue;
        }
        if (TOAST_COPY_FIELDS.has(key)) {
          checkExpression(property.value, "toast", {});
        }
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

      // Every argument, not just the first: `toast.error(t("x"), {
      // description: "raw" })` carries its untranslated half in the options
      // bag, and `toast.promise(p, { loading, success })` puts a promise where
      // the message would be and all of its copy in the bag.
      CallExpression(node) {
        if (!isToastCall(node.callee)) {
          return;
        }
        for (const argument of node.arguments) {
          if (insideTranslationCall(argument)) {
            continue;
          }
          if (argument.type === "ObjectExpression") {
            checkToastOptions(argument);
            continue;
          }
          checkExpression(argument, "toast", {});
        }
      },
    };
  },
};
