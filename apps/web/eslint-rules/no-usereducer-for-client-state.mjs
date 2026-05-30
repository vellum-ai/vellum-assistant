/**
 * Custom ESLint rule: no-usereducer-for-client-state.
 *
 * The codebase standardizes on Zustand stores with direct named
 * actions as the single client-state primitive. `useReducer` locks
 * state into a single component subtree, prevents atomic
 * selectors, has no devtools, doesn't survive remount, and
 * duplicates the React state primitive Zustand already covers.
 *
 * The only documented exceptions are
 * `apps/web/src/domains/terminal/use-terminal-state.ts` and
 * `apps/web/src/domains/terminal/use-terminal-session.ts`, both
 * pending migration. To extend the exception list, edit the
 * `EXEMPT_PATH_FRAGMENTS` array below — adding a path here is a
 * deliberate decision, not a one-off escape.
 *
 * See `apps/web/docs/STATE_MANAGEMENT.md` → "useReducer is not
 * used for client state".
 */
import path from "node:path";

const EXEMPT_PATH_FRAGMENTS = ["/src/domains/terminal/"];

function isExempt(filePath) {
  const posix = filePath.split(path.sep).join("/");
  return EXEMPT_PATH_FRAGMENTS.some((frag) => posix.includes(frag));
}

export const noUseReducerForClientState = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow useReducer for client state; use Zustand with named actions.",
    },
    schema: [],
    messages: {
      useReducer:
        "Do not use useReducer for client state. Use a Zustand store with " +
        "direct named actions instead. See STATE_MANAGEMENT.md → " +
        "'useReducer is not used for client state'.",
    },
  },
  create(context) {
    const filePath = context.filename ?? context.getFilename();
    if (isExempt(filePath)) return {};
    function check(node) {
      // Direct call: useReducer(...)
      if (node.callee.type === "Identifier" && node.callee.name === "useReducer") {
        context.report({ node, messageId: "useReducer" });
        return;
      }
      // React.useReducer(...)
      if (
        node.callee.type === "MemberExpression" &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "useReducer"
      ) {
        context.report({ node, messageId: "useReducer" });
      }
    }
    return { CallExpression: check };
  },
};
