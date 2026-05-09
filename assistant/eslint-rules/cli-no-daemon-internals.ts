import type { Rule } from "eslint";
import type {
  CallExpression,
  ImportDeclaration,
  Node,
  ObjectExpression,
  Program,
} from "estree";

/**
 * Allowed import prefixes per transport class.
 *
 * "ipc" commands run after the daemon is up and communicate over the Unix
 * domain socket, so they may import the IPC client, logger, and output
 * helpers plus anything in the shared lib/.
 *
 * "local" and "bootstrap" commands run without a live daemon (or during
 * its bootstrap phase), so they must stay away from IPC internals and may
 * only touch config, platform utilities, and the shared lib/.
 */
const ALLOWED_PREFIXES: Record<string, string[]> = {
  ipc: [
    "node:",
    "bun:",
    "commander",
    "../../ipc/cli-client",
    "../logger",
    "../output",
    "../lib/",
  ],
  local: [
    "node:",
    "bun:",
    "commander",
    "../../config/loader",
    "../../config/schema",
    "../../util/platform",
    "../lib/",
  ],
  bootstrap: [
    "node:",
    "bun:",
    "commander",
    "../../config/loader",
    "../../config/schema",
    "../../util/platform",
    "../lib/",
  ],
};

/**
 * Iteratively walk the AST body (top-level and nested expression statements)
 * to find a `registerCommand(program, { transport: "..." })` call.
 *
 * We avoid generic deep recursion to prevent call-stack overflows on large
 * TypeScript ASTs with circular parent/scope references. Instead, we only
 * walk into the parts of the tree that could contain a top-level call or a
 * call nested inside an export/function declaration.
 */
function findTransport(program: Program): string | null {
  const worklist: Node[] = [...program.body];
  const seen = new WeakSet<object>();

  while (worklist.length > 0) {
    const node = worklist.pop()!;

    if (!node || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);

    // Check if this node is the target call expression.
    if (
      node.type === "CallExpression" &&
      (node as CallExpression).callee.type === "Identifier" &&
      ((node as CallExpression).callee as { name: string }).name ===
        "registerCommand"
    ) {
      const call = node as CallExpression;
      // Scan all arguments for an ObjectExpression with a transport property.
      for (const arg of call.arguments) {
        if (arg.type === "ObjectExpression") {
          const objExpr = arg as ObjectExpression;
          for (const prop of objExpr.properties) {
            if (
              prop.type === "Property" &&
              prop.key.type === "Identifier" &&
              (prop.key as { name: string }).name === "transport" &&
              prop.value.type === "Literal" &&
              typeof (prop.value as { value: unknown }).value === "string"
            ) {
              return (prop.value as { value: string }).value;
            }
          }
        }
      }
    }

    // Push children that may contain call expressions.
    // We only drill into statement/expression wrappers to avoid cycles.
    switch (node.type) {
      case "ExpressionStatement":
        worklist.push((node as { expression: Node }).expression);
        break;
      case "CallExpression": {
        const call = node as CallExpression;
        for (const arg of call.arguments) {
          worklist.push(arg as Node);
        }
        break;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const fn = node as {
          body: Node;
          params?: Node[];
        };
        if (fn.body) worklist.push(fn.body);
        break;
      }
      case "BlockStatement": {
        for (const stmt of (node as { body: Node[] }).body) {
          worklist.push(stmt);
        }
        break;
      }
      case "ReturnStatement": {
        const ret = node as { argument?: Node };
        if (ret.argument) worklist.push(ret.argument);
        break;
      }
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration": {
        const exp = node as { declaration?: Node };
        if (exp.declaration) worklist.push(exp.declaration);
        break;
      }
      case "VariableDeclaration": {
        for (const decl of (node as { declarations: { init?: Node }[] })
          .declarations) {
          if (decl.init) worklist.push(decl.init);
        }
        break;
      }
      case "ObjectExpression": {
        for (const prop of (
          node as { properties: { value: Node; type: string }[] }
        ).properties) {
          if (prop.type === "Property") {
            worklist.push(prop.value);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return null;
}

const rule: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce import allowlists for CLI commands by transport class",
    },
    messages: {
      missingTransport:
        "CLI command file must call registerCommand({ transport: ... }) to declare its transport class.",
      forbiddenImport:
        "'{{transport}}'-tagged CLI command imports forbidden module '{{source}}'. See DESIGN.md §3.1 for allowed imports.",
    },
    schema: [],
  },

  create(context: Rule.RuleContext) {
    const importNodes: ImportDeclaration[] = [];

    return {
      ImportDeclaration(node: ImportDeclaration) {
        importNodes.push(node);
      },

      "Program:exit"(program: Program) {
        // Skip files with zero imports — they may be pure utilities.
        if (importNodes.length === 0) {
          return;
        }

        const transport = findTransport(program);

        if (transport === null) {
          // No registerCommand with transport found — warn on Program node.
          context.report({
            node: program,
            messageId: "missingTransport",
          });
          return;
        }

        const allowedPrefixes = ALLOWED_PREFIXES[transport];
        if (!allowedPrefixes) {
          // Unknown transport — no allowlist to enforce.
          return;
        }

        for (const importNode of importNodes) {
          const source = importNode.source.value as string;
          const allowed = allowedPrefixes.some((prefix) =>
            source.startsWith(prefix),
          );
          if (!allowed) {
            context.report({
              node: importNode,
              messageId: "forbiddenImport",
              data: {
                transport,
                source,
              },
            });
          }
        }
      },
    };
  },
};

export default rule;
