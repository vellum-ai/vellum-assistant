import path from "node:path";

/**
 * `cli/no-daemon-internals`
 *
 * Forbids CLI command files from *hoisting* (statically importing at module
 * top level) any module that lives outside the CLI's own tree or the shared
 * leaf zones. Top-level imports load on every `assistant …` invocation, so
 * pulling a daemon subsystem into the static graph inflates the memory
 * footprint of every command — including the bash-tool fast path that only
 * meant to run one small verb.
 *
 * The rule is purely structural — no per-module allowlist. Hoisted imports may
 * resolve only to:
 *   - non-relative specifiers (Node/npm/`bun:`/scoped packages), or
 *   - the CLI's own tree (`src/cli/**`), or
 *   - the shared non-daemon leaf zones below (`util/`, `ipc/`, `types/`,
 *     `version`), which carry no daemon runtime graph.
 *
 * Everything else under `src/` is daemon-internal and must be reached with a
 * dynamic `import()` inside the action, so it loads only when the command
 * actually runs. Type-only imports are always fine — they are erased at
 * compile time and cost nothing at runtime. Dynamic `import()` expressions are
 * not `ImportDeclaration`s, so they are never flagged.
 */

// Top-level `src/` directories that hold no daemon runtime graph and may be
// hoisted into the CLI's static import graph. These are whole non-daemon
// categories, not carve-outs for individual daemon modules: the CLI itself,
// shared leaf utilities, the IPC transport (client + socket path), and type
// declarations.
const SAFE_DIRS = new Set(["cli", "util", "ipc", "types"]);
// Individual leaf files directly under `src/` that may be hoisted (e.g. the
// app version constant `src/version.ts`).
const SAFE_ROOT_FILES = new Set(["version"]);

/**
 * Given the importing file and an import specifier, decide whether hoisting it
 * is allowed. Returns true (allowed) for anything that is not a
 * daemon-internal module.
 */
function isHoistAllowed(filename, specifier) {
  // Non-relative specifiers are packages (Node/npm/bun/scoped) — always fine.
  if (!specifier.startsWith(".")) {
    return true;
  }

  // Locate the `.../src/cli/` prefix of the importing file to anchor `src/`.
  const marker = `${path.sep}src${path.sep}cli${path.sep}`;
  const markerIdx = filename.indexOf(marker);
  if (markerIdx === -1) {
    // Not a file under src/cli — the rule's file glob shouldn't match it, so
    // be conservative and don't flag.
    return true;
  }
  const srcRoot = filename.slice(0, markerIdx) + `${path.sep}src`;

  const resolved = path.resolve(path.dirname(filename), specifier);
  const relFromSrc = path.relative(srcRoot, resolved);

  // Resolves outside `src/` entirely (unusual for a relative import) — leave
  // it alone; it isn't a daemon-internal module.
  if (relFromSrc.startsWith("..")) {
    return true;
  }

  const segments = relFromSrc.split(path.sep);
  const firstSegment = segments[0];

  // A leaf file directly under src/ (e.g. `version.js`).
  if (segments.length === 1) {
    return SAFE_ROOT_FILES.has(firstSegment.replace(/\.[jt]s$/, ""));
  }

  return SAFE_DIRS.has(firstSegment);
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid CLI command files from hoisting daemon-internal imports (lazy-import them inside the action instead)",
    },
    messages: {
      hoistedDaemonImport:
        "CLI command hoists daemon-internal module '{{source}}'. Import it lazily inside the action (`await import(...)`) so it stays out of the CLI's static graph. See src/cli/AGENTS.md.",
    },
    schema: [],
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();

    return {
      ImportDeclaration(node) {
        // `import type { … } from "…"` — erased at compile time. Skip.
        if (node.importKind === "type") {
          return;
        }
        // Inline-type form `import { type A, type B } from "…"`: when *every*
        // named specifier is type-only the whole import is erased. Skip those.
        // Side-effect-only imports (`import "x"`) have no specifiers and run at
        // load time — do not skip those.
        if (
          node.specifiers.length > 0 &&
          node.specifiers.every(
            (s) => s.type === "ImportSpecifier" && s.importKind === "type",
          )
        ) {
          return;
        }

        const source = node.source.value;
        if (typeof source !== "string") {
          return;
        }
        if (!isHoistAllowed(filename, source)) {
          context.report({
            node,
            messageId: "hoistedDaemonImport",
            data: { source },
          });
        }
      },
    };
  },
};

export default rule;
