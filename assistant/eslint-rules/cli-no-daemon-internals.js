// Import prefixes allowed for each transport class. Entries cover both
// depth-1 (e.g. `commands/foo.ts`) and depth-2 (e.g. `commands/oauth/bar.ts`)
// relative paths so nested command directories don't false-positive.
//
// Adding a new entry: prefer the narrowest match that captures the legitimate
// case. Daemon-internal modules (`runtime/`, `services/`, `agents/`, `llm/`,
// `skills/`, etc.) MUST remain off the allowlist for `ipc`-tagged commands.
const ALLOWED_PREFIXES = {
  ipc: [
    "node:",
    "bun:",
    "commander",
    // Sibling subcommand composition (e.g. oauth/index.ts -> ./connect.js).
    // The imported file is itself a command and the rule will check its
    // imports independently, so this can't be used to smuggle daemon
    // internals through a sibling re-export.
    "./",
    // IPC client at depth-1 and depth-2.
    "../../ipc/cli-client",
    "../../../ipc/cli-client",
    // Status command's daemon-down fallback needs socket path + platform.
    "../../ipc/socket-path",
    "../../util/platform",
    // App version constant (leaf module; reads package.json/env, no daemon
    // deps) — status prints it to surface CLI-vs-runtime version drift.
    "../../version",
    "../../../version",
    // Robust stdin reader (leaf module; only node:fs, no daemon deps) —
    // commands that accept piped payloads read fd 0 through it at depth-1
    // and depth-2.
    "../../util/read-stdin",
    "../../../util/read-stdin",
    // Logger / output at depth-1 and depth-2.
    "../logger",
    "../output",
    "../../logger",
    "../../output",
    // Shared CLI lib / utils at depth-1 and depth-2.
    "../lib/",
    "../../lib/",
    "../utils/",
    "../../utils/",
    // Environment access for commands that need to read VELLUM_* env vars
    // before issuing IPC calls (e.g. email, domain).
    "../../config/env",
    // Browser command's operation metadata (drives subcommand generation).
    // Deliberately the meta-only module: `../../browser/operations` would
    // pull the Playwright-backed execution stack into every CLI start.
    "../../browser/operation-meta",
  ],
  local: [
    "node:",
    "bun:",
    "commander",
    "zod",
    // Sibling helpers + cross-namespace helper for config.ts managed-mode
    // check (see commands/oauth/shared.ts docstring).
    "./",
    // Config schema/loader at depth-1 and depth-2.
    "../../config/loader",
    "../../../config/loader",
    "../../config/schema",
    "../../config/env",
    "../../util/platform",
    "../../../util/platform",
    // Memory retrospective — the retrospective CLI runs the fork-based
    // retrospective in-process (no daemon, no IPC), so it imports the
    // job handler directly from the default-memory plugin. Depth-2 for
    // commands/memory/ nesting.
    "../../plugins/defaults/memory/memory-retrospective-job",
    "../../../plugins/defaults/memory/memory-retrospective-job",
    // Memory nodes CRUD — `memory nodes list/delete/update` invoke the graph
    // tool-handlers directly in-process (no IPC, no daemon dependency).
    // Depth-3 for commands/memory/ nesting.
    "../../../plugins/defaults/memory/graph/tool-handlers",
    // Standalone tool execution — `tools run` executes a single tool
    // in-process from the filesystem (no daemon, no IPC), so it imports the
    // standalone runner directly. Depth-2 for commands/ nesting.
    "../../tools/run-standalone",
    "../../../tools/run-standalone",
    "../logger",
    "../output",
    "../../logger",
    "../../output",
    "../lib/",
    "../../lib/",
    "../utils/",
    "../../utils/",
    // Secure key storage (keys.ts) needs direct security module access —
    // by design, the secure-key helpers run in-process (not over IPC).
    "../../security/",
    // Canonical API-key provider list (keys.ts help text + validation) —
    // a static metadata catalog with no daemon state.
    "../../providers/provider-secret-catalog",
    // CES bridge (credential-execution.ts) speaks to the CES sidecar via
    // service-contracts RPC; daemon is not involved.
    "../../credential-execution/",
    "@vellumai/service-contracts",
  ],
  bootstrap: [
    "node:",
    "bun:",
    "commander",
    "./",
    "../../config/loader",
    "../../config/schema",
    "../../config/env",
    "../../util/platform",
    "../logger",
    "../output",
    "../../logger",
    "../../output",
    "../lib/",
    "../../lib/",
    "../utils/",
    "../../utils/",
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
        // Enqueue both arguments AND the callee so chained patterns like
        // `registerCommand(...).command(...).description(...)` are walked.
        // The outer call's callee is a MemberExpression whose object is the
        // inner CallExpression; without traversing the callee we'd never
        // reach the inner `registerCommand` invocation and findTransport()
        // would return null, silently skipping all checks.
        worklist.push(node.callee);
        for (const arg of node.arguments) {
          worklist.push(arg);
        }
        break;
      case "MemberExpression":
        // Reach through `.foo` chains so we can walk into the receiver.
        worklist.push(node.object);
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
          // `import type {...}` is erased at compile time — top-level type
          // import kind is set to "type" on the declaration. Skip.
          if (importNode.importKind === "type") {
            continue;
          }
          // Inline-type form `import { type X, type Y } from "..."` keeps
          // the declaration `importKind === "value"` while marking each
          // ImportSpecifier with `importKind === "type"`. When *every*
          // specifier is type-only the entire import is erased. Skip those
          // too. Side-effect-only imports (`import "x"`) have an empty
          // specifiers list and run at module load — must NOT skip.
          if (
            importNode.specifiers.length > 0 &&
            importNode.specifiers.every(
              (s) => s.type === "ImportSpecifier" && s.importKind === "type",
            )
          ) {
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
