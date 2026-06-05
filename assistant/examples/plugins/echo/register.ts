/**
 * Echo plugin — observes the assistant's turn-lifecycle hooks and logs one
 * structured line per hook invocation to stderr.
 *
 * Bundled in the repository as an authoring reference. To try it locally,
 * symlink (or copy) this directory into `<workspaceDir>/plugins/echo/` and
 * restart the assistant. See `README.md` in this directory for the install
 * recipe and `assistant/docs/plugins.md` for general plugin authoring docs.
 *
 * ## Runtime bridge
 *
 * The plugin reads `registerPlugin` from `globalThis.__vellumPluginRuntime`,
 * a stable handle the daemon attaches at startup. This lets the same plugin
 * file work whether the daemon is running from source (relative or absolute
 * imports would resolve to the daemon's modules) or as a `bun --compile`
 * binary (where absolute imports would load a disjoint disk copy with a
 * separate registry instance). The bridge is documented in
 * `assistant/src/plugins/external-api.ts`.
 *
 * Type imports below still come from the in-repo source tree. Types are
 * erased at runtime, so they don't affect module identity — but they only
 * resolve while this file lives inside the vellum-assistant checkout. For a
 * standalone-copy install, rewrite the `import type` paths to absolute paths
 * inside a checkout (or vendor only the types you need).
 *
 * ## Design
 *
 * - Registers an observer hook for each turn-lifecycle event
 *   (`user-prompt-submit`, `post-tool-use`, `stop`).
 * - Each hook emits one JSON line on `stderr` with `{ plugin, hook,
 *   conversationId }` and returns `void`, leaving the threaded context
 *   untouched. The plugin is purely observational — it never mutates the
 *   turn's messages, tool results, or stop decision.
 *
 * The file exports no named symbols at module level — it only runs
 * `registerPlugin(echoPlugin)` as an import-time side effect, matching the
 * user-plugin-loader contract (see `assistant/src/plugins/user-loader.ts`).
 */

import { HOOKS } from "../../../src/plugin-api/constants.js";
import type {
  PostToolUseContext,
  StopContext,
  UserPromptSubmitContext,
} from "../../../src/plugin-api/types.js";
import type { VellumPluginRuntime } from "../../../src/plugins/external-api.js";
import type { Plugin } from "../../../src/plugins/types.js";

const runtime = (globalThis as { __vellumPluginRuntime?: VellumPluginRuntime })
  .__vellumPluginRuntime;
if (!runtime || runtime.version !== 1) {
  throw new Error(
    "echo plugin: globalThis.__vellumPluginRuntime is missing or has an unexpected version — install a recent assistant build",
  );
}
const { registerPlugin } = runtime;

const PLUGIN_NAME = "echo";

/**
 * One line written to stderr per hook invocation. Kept intentionally compact —
 * pino-style JSON so operators can pipe the assistant's stderr through `jq`
 * without reshaping.
 */
function emit(hook: string, conversationId: string): void {
  const record = { plugin: PLUGIN_NAME, hook, conversationId };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

/**
 * The echo plugin. Declares one observer hook per turn-lifecycle event — each
 * logs and returns `void`, so the threaded context flows through unchanged.
 *
 * Manifest:
 * - Host-compat range lives in `package.json` under
 *   `peerDependencies["@vellumai/plugin-api"]`. The external-plugin loader
 *   validates it against the running assistant version via
 *   `semver.satisfies()` before this file is even imported.
 * - No `requiresCredential` or `requiresFlag` — the plugin needs no external
 *   state and runs unconditionally.
 */
const echoPlugin: Plugin = {
  manifest: {
    name: PLUGIN_NAME,
    version: "0.1.0",
  },
  hooks: {
    [HOOKS.USER_PROMPT_SUBMIT]: async (ctx: UserPromptSubmitContext) => {
      emit(HOOKS.USER_PROMPT_SUBMIT, ctx.conversationId);
    },
    [HOOKS.POST_TOOL_USE]: async (ctx: PostToolUseContext) => {
      emit(HOOKS.POST_TOOL_USE, ctx.conversationId);
    },
    [HOOKS.STOP]: async (ctx: StopContext) => {
      emit(HOOKS.STOP, ctx.conversationId);
    },
  },
};

// Side-effect registration — the user-plugin loader dynamic-imports this
// file and expects the registry to pick up the plugin during that import.
registerPlugin(echoPlugin);
