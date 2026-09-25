/**
 * Custom ESLint rule: prefer-design-library-controls.
 *
 * `@vellumai/design-library` has a primitive for every control a screen
 * needs: `Button` (with `iconOnly`, `loading`, `variant="link"`), `TextLink`,
 * `Chip`, `FilterChip`, `ListRow`, `PanelItem`, `OptionCard`, `Disclosure`.
 * A component audit on 2026-09-18 found the app hand-rolling them anyway:
 * 268 raw `<button>` elements, 24 external anchors missing the native-shell
 * click handler, 20 divs acting as buttons, and dozens of focus rings that
 * paint on tap because they use `focus-visible:` instead of the library's
 * `keyboard-focus:` variant. Each is invisible in review: a raw button looks
 * like a button until someone tabs to it, taps it on a phone, or turns on a
 * screen reader.
 *
 * This rule reports the five shapes that audit kept finding:
 *
 * 1. A raw `<button>` element. Use `Button`, or a row or chip primitive.
 * 2. An `<a>` with `target="_blank"`. Use `ExternalAnchor`, which carries the
 *    `noopener noreferrer` hardening and the handler that makes the link work
 *    inside the iOS and Android shells, where a bare `_blank` anchor does
 *    nothing.
 * 3. `role="button"` on any element. A real button, or `PanelItem`, gets the
 *    keyboard and screen-reader contract for free.
 * 4. A `focus-visible:` utility in a className. The library's `keyboard-focus:`
 *    variant draws the ring only for keyboard focus, so a tap or a
 *    programmatic focus does not flash it.
 * 5. A `Loader2` or `LoaderCircle` element inside a `Button`'s props or
 *    children. Pass `loading` instead; the Button owns the spinner,
 *    `aria-busy` and click blocking.
 *
 * Scoped, not global, like `local/no-em-dash`: `eslint.config.mjs` enables it
 * only for `designLibraryEnforcedPaths`. The audit's leftovers are cleaned an
 * area at a time, and each migration PR adds its area to that list so it
 * cannot regress. A rule that reported all 268 at once would be switched off
 * rather than obeyed.
 *
 * No autofix. Which primitive replaces a raw control depends on what the
 * control is (an action, a link, a row, a toggle), and the swap usually moves
 * props around. See the "Which primitive" table in `docs/STYLE_GUIDE.md`.
 *
 * Escape hatch, for a control the library genuinely cannot express (a colour
 * swatch, a drag handle, a canvas overlay, a whole-surface hit area):
 *
 *   {/* eslint-disable-next-line local/prefer-design-library-controls -- swatch, no library primitive *\/}
 *
 * The reason is required by convention so the list of exceptions stays
 * greppable and each one says why it exists.
 */

const MESSAGES = {
  rawButton:
    "Raw <button>. Use Button from @vellumai/design-library (iconOnly for a glyph, variant=\"link\" for a link-shaped action), or a row or chip primitive. See docs/STYLE_GUIDE.md, \"Which primitive\".",
  blankAnchor:
    "<a target=\"_blank\"> does nothing inside the iOS and Android shells. Use ExternalAnchor from @/components/external-anchor, which carries the native click handler and the rel hardening.",
  roleButton:
    "role=\"button\" on a non-button element. Use a real Button, or PanelItem / ListRow for a row, so keyboard activation and focus come for free.",
  focusVisible:
    "focus-visible: paints the ring on tap and on programmatic focus. Use the library's keyboard-focus: variant (keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]).",
  spinnerInButton:
    "A spinner inside a Button. Pass loading={...} instead: the Button owns the spinner, aria-busy and click blocking.",
};

const SPINNER_NAMES = new Set(["Loader2", "LoaderCircle"]);

function jsxName(node) {
  const name = node.name;
  if (!name) {
    return null;
  }
  if (name.type === "JSXIdentifier") {
    return name.name;
  }
  // `Menu.Item` and other member expressions are library compounds, never a
  // raw element, so they have nothing to report.
  return null;
}

function attribute(node, attrName) {
  return node.attributes.find(
    (attr) =>
      attr.type === "JSXAttribute" &&
      attr.name.type === "JSXIdentifier" &&
      attr.name.name === attrName,
  );
}

/** The static string value of an attribute, or null when it is dynamic. */
function staticValue(attr) {
  if (!attr || !attr.value) {
    return null;
  }
  if (attr.value.type === "Literal" && typeof attr.value.value === "string") {
    return attr.value.value;
  }
  if (
    attr.value.type === "JSXExpressionContainer" &&
    attr.value.expression.type === "Literal" &&
    typeof attr.value.expression.value === "string"
  ) {
    return attr.value.expression.value;
  }
  return null;
}

/**
 * Every string literal and template chunk under `node`, so a className built
 * with `cn(...)`, a ternary or an array is still searched.
 */
function stringPieces(node, out = []) {
  if (!node || typeof node !== "object") {
    return out;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    out.push({ text: node.value, node });
    return out;
  }
  if (node.type === "TemplateElement") {
    out.push({ text: node.value.cooked ?? node.value.raw, node });
    return out;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range") {
      continue;
    }
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") {
          stringPieces(item, out);
        }
      }
    } else if (child && typeof child.type === "string") {
      stringPieces(child, out);
    }
  }
  return out;
}

const FOCUS_VISIBLE = /(^|[\s"'`(])focus-visible:/;

function containsSpinner(node) {
  if (!node || typeof node !== "object") {
    return false;
  }
  if (
    node.type === "JSXElement" &&
    node.openingElement.name.type === "JSXIdentifier" &&
    SPINNER_NAMES.has(node.openingElement.name.name)
  ) {
    return true;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range") {
      continue;
    }
    const child = node[key];
    if (Array.isArray(child)) {
      if (child.some((item) => item && typeof item.type === "string" && containsSpinner(item))) {
        return true;
      }
    } else if (child && typeof child.type === "string" && containsSpinner(child)) {
      return true;
    }
  }
  return false;
}

export const preferDesignLibraryControls = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Prefer @vellumai/design-library controls over raw buttons, bare external anchors, role=button, focus-visible rings and hand-rolled spinners.",
    },
    schema: [],
    messages: MESSAGES,
  },

  create(context) {
    return {
      JSXOpeningElement(node) {
        const name = jsxName(node);

        if (name === "button") {
          context.report({ node: node.name, messageId: "rawButton" });
        }

        if (name === "a" && staticValue(attribute(node, "target")) === "_blank") {
          context.report({ node: node.name, messageId: "blankAnchor" });
        }

        const role = attribute(node, "role");
        if (role && staticValue(role) === "button") {
          context.report({ node: role, messageId: "roleButton" });
        }

        const className = attribute(node, "className");
        if (className && className.value) {
          const pieces = stringPieces(
            className.value.type === "JSXExpressionContainer"
              ? className.value.expression
              : className.value,
          );
          const hit = pieces.find((piece) => FOCUS_VISIBLE.test(piece.text));
          if (hit) {
            context.report({ node: hit.node, messageId: "focusVisible" });
          }
        }

        if (name === "Button") {
          for (const prop of ["leftIcon", "rightIcon", "iconOnly"]) {
            const attr = attribute(node, prop);
            if (attr && attr.value && containsSpinner(attr.value)) {
              context.report({ node: attr, messageId: "spinnerInButton" });
            }
          }
          const element = node.parent;
          if (element && element.type === "JSXElement") {
            for (const child of element.children) {
              if (containsSpinner(child)) {
                context.report({ node: child, messageId: "spinnerInButton" });
                break;
              }
            }
          }
        }
      },
    };
  },
};
