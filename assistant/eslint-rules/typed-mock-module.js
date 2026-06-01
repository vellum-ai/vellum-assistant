/**
 * ESLint rule: mock/typed-module
 *
 * Warns when a mock.module() factory returns an untyped object literal.
 * Without a `satisfies Partial<typeof import("…")>` constraint, Bun's
 * mock.module returns `any` — TypeScript cannot detect when mock
 * signatures drift from the production module they replace.
 *
 * @see https://bun.sh/docs/test/mocking#mock-module
 */

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require `satisfies` on mock.module() factory returns to prevent signature drift",
    },
    messages: {
      untypedMockModule:
        'mock.module() factory return is untyped. Add `satisfies Partial<typeof import("{{path}}")>` so tsc catches signature drift when the production module changes.',
    },
    schema: [],
  },

  create(context) {
    return {
      CallExpression(node) {
        // Match: mock.module("path", factory)
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.object.type !== "Identifier" ||
          node.callee.object.name !== "mock" ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "module"
        ) {
          return;
        }

        if (node.arguments.length < 2) return;

        const pathArg = node.arguments[0];
        const factoryArg = node.arguments[1];

        // Only lint string-literal module paths
        if (pathArg.type !== "Literal" || typeof pathArg.value !== "string") {
          return;
        }

        // Only lint inline factory functions (arrow or function expression)
        if (
          factoryArg.type !== "ArrowFunctionExpression" &&
          factoryArg.type !== "FunctionExpression"
        ) {
          return;
        }

        const returnExpr = getReturnExpression(factoryArg);
        if (!returnExpr) return;

        // Already has `satisfies` — nothing to report
        if (returnExpr.type === "TSSatisfiesExpression") return;

        // Only warn on bare object literals — delegates to helper functions
        // (CallExpression, Identifier, etc.) may be typed elsewhere
        if (returnExpr.type !== "ObjectExpression") return;

        context.report({
          node: returnExpr,
          messageId: "untypedMockModule",
          data: { path: pathArg.value },
        });
      },
    };
  },
};

/**
 * Extract the returned expression from a factory function.
 *
 * Handles:
 *   - Arrow expression body: `() => expr`
 *   - Block body with return:  `() => { return expr; }`
 */
function getReturnExpression(fn) {
  // Arrow with expression body: `() => ({ … })`
  if (
    fn.type === "ArrowFunctionExpression" &&
    fn.body.type !== "BlockStatement"
  ) {
    return fn.body;
  }

  // Block body — find the first return with an argument
  const body = fn.body;
  if (body.type !== "BlockStatement") return null;

  for (const stmt of body.body) {
    if (stmt.type === "ReturnStatement" && stmt.argument) {
      return stmt.argument;
    }
  }

  return null;
}

export default rule;
