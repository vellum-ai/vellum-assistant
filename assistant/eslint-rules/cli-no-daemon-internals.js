const ALLOWED_PREFIXES = {
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
    "../logger",
    "../output",
    "../lib/",
  ],
  bootstrap: [
    "node:",
    "bun:",
    "commander",
    "../../config/loader",
    "../../config/schema",
    "../../util/platform",
    "../logger",
    "../output",
    "../lib/",
  ],
};

/**
 * Walks the program AST looking for a `registerCommand({ transport: ... })`
 * call. Returns:
 *   - the transport string when registerCommand is called with a string
 *     transport prop ("ipc" / "local" / "bootstrap")
 *   - "MISSING_TRANSPORT" when registerCommand is called but no string
 *     transport prop is present
 *   - null when no registerCommand call is found at all (helper module —
 *     not a command entry, no checks apply)
 */
function findTransport(program) {
  const worklist = [...program.body];
  const seen = new WeakSet();
  let registerCommandCalled = false;

  while (worklist.length > 0) {
    const node = worklist.pop();

    if (!node || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);

    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "registerCommand"
    ) {
      registerCommandCalled = true;
      for (const arg of node.arguments) {
        if (arg.type === "ObjectExpression") {
          for (const prop of arg.properties) {
            if (
              prop.type === "Property" &&
              prop.key.type === "Identifier" &&
              prop.key.name === "transport" &&
              prop.value.type === "Literal" &&
              typeof prop.value.value === "string"
            ) {
              return prop.value.value;
            }
          }
        }
      }
    }

    switch (node.type) {
      case "ExpressionStatement":
        worklist.push(node.expression);
        break;
      case "CallExpression":
        for (const arg of node.arguments) {
          worklist.push(arg);
        }
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (node.body) worklist.push(node.body);
        break;
      case "BlockStatement":
        for (const stmt of node.body) {
          worklist.push(stmt);
        }
        break;
      case "ReturnStatement":
        if (node.argument) worklist.push(node.argument);
        break;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        if (node.declaration) worklist.push(node.declaration);
        break;
      case "VariableDeclaration":
        for (const decl of node.declarations) {
          if (decl.init) worklist.push(decl.init);
        }
        break;
      case "ObjectExpression":
        for (const prop of node.properties) {
          if (prop.type === "Property") {
            worklist.push(prop.value);
          }
        }
        break;
      default:
        break;
    }
  }

  return registerCommandCalled ? "MISSING_TRANSPORT" : null;
}

const rule = {
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
        "'{{transport}}'-tagged CLI command imports forbidden module '{{source}}'. See src/cli/AGENTS.md for allowed imports.",
    },
    schema: [],
  },

  create(context) {
    const importNodes = [];

    return {
      ImportDeclaration(node) {
        importNodes.push(node);
      },

      "Program:exit"(program) {
        if (importNodes.length === 0) {
          return;
        }

        const transport = findTransport(program);

        // Helper modules (no registerCommand call) are not command entries —
        // skip them. Command files that call registerCommand without a string
        // transport prop still trip missingTransport.
        if (transport === null) {
          return;
        }

        if (transport === "MISSING_TRANSPORT") {
          context.report({
            node: program,
            messageId: "missingTransport",
          });
          return;
        }

        const allowedPrefixes = ALLOWED_PREFIXES[transport];
        if (!allowedPrefixes) {
          return;
        }

        for (const importNode of importNodes) {
          // `import type {...}` and `import { type X }` are erased at compile
          // time — they don't ship in the bundle and don't constitute a
          // runtime boundary violation. Skip them.
          if (importNode.importKind === "type") {
            continue;
          }
          const source = importNode.source.value;
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
