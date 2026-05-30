/**
 * Custom ESLint rule: no-outlet-context-outside-layouts.
 *
 * React Router outlet context [re-renders every consumer when any
 * field changes](https://reactrouter.com/start/framework/outlet),
 * forces a bundled value through every layout layer, and silently
 * resolves to `undefined` whenever an intermediate `<Outlet />`
 * (a gate, a wrapper) sits between writer and reader. Cross-route
 * state — auth, lifecycle, selection, feature flags, layout slots —
 * belongs in a Zustand store so consumers can subscribe atomically
 * and so intermediate routes can't break the channel.
 *
 * Use outlet context only for one-shot parent → direct-child
 * wiring with no intermediate routes. In this codebase the only
 * legitimate use is layout components that publish to their own
 * direct children — `RootLayout`, `ChatLayout`, etc.
 *
 * This rule flags `useOutletContext()` calls in files NOT matching
 * a layout-file pattern. The allow-list is intentionally small:
 *
 *   - `*-layout.{ts,tsx}` — the convention for layout-component files
 *   - `root-layout.{ts,tsx}` — special-cased
 *
 * To add a new layout file, name it with the `-layout` suffix.
 *
 * See `apps/web/AGENTS.md` → "Common pitfalls" → outlet context.
 */
import path from "node:path";

const ALLOWED_BASENAME_PATTERNS = [
  /-layout\.(ts|tsx)$/,
  /^root-layout\.(ts|tsx)$/,
];

function isAllowedLayoutFile(filePath) {
  const basename = path.basename(filePath);
  return ALLOWED_BASENAME_PATTERNS.some((re) => re.test(basename));
}

export const noOutletContextOutsideLayouts = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow useOutletContext() outside layout-component files.",
    },
    schema: [],
    messages: {
      outsideLayout:
        "Outlet context shouldn't be used outside a layout component. " +
        "Intermediate `<Outlet />` calls resolve outlet context to " +
        "`undefined`, so cross-route state breaks silently when a gate or " +
        "wrapper sits between writer and reader. Use a Zustand store for " +
        "cross-route state. See AGENTS.md → 'Common pitfalls'.",
    },
  },
  create(context) {
    const filePath = context.filename ?? context.getFilename();
    if (isAllowedLayoutFile(filePath)) return {};
    function check(node) {
      // Direct call: useOutletContext(...)
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "useOutletContext"
      ) {
        context.report({ node, messageId: "outsideLayout" });
        return;
      }
      // ReactRouter.useOutletContext(...) — defensive.
      if (
        node.callee.type === "MemberExpression" &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "useOutletContext"
      ) {
        context.report({ node, messageId: "outsideLayout" });
      }
    }
    return { CallExpression: check };
  },
};
