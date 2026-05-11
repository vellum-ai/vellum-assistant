/**
 * @vellumai/simple-memory — Phase 0 experimental plugin.
 *
 * Entry point. Composes hooks, tools, and an injector contributed by this
 * package into a single plugin object. The harness consumes this export;
 * the plugin module itself imports nothing outside its own directory.
 */

import { init } from "./hooks/init.js";
import { onShutdown } from "./hooks/shutdown.js";
import { entriesFor } from "./state.js";
import { recallTool } from "./tools/recall.js";
import { rememberTool } from "./tools/remember.js";

// ─── Injector ────────────────────────────────────────────────────────────────
//
// Order 25 slots this between the default unified turn-context injector
// (10) and the default PKB injector (~30); `after-memory-prefix` placement
// lands us in the canonical memory ordering. Skipped on turns with zero
// entries.

interface InjectorContext {
  conversationId: string;
}

const entriesInjector = {
  name: "simple-memory/entries",
  order: 25,
  async produce(ctx: InjectorContext) {
    const ours = entriesFor(ctx.conversationId);
    if (ours.length === 0) return null;
    const body = ours
      .map((e) => `- [${new Date(e.createdAt).toISOString()}] ${e.text}`)
      .join("\n");
    return {
      id: "simple-memory/entries",
      text: `<simple_memory>\n${body}\n</simple_memory>`,
      placement: "after-memory-prefix" as const,
      meta: { plugin: "simple-memory", count: ours.length },
    };
  },
};

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const plugin = {
  manifest: {
    name: "simple-memory",
    provides: {},
    requires: { pluginRuntime: "v1" as const },
  },
  init,
  onShutdown,
  injectors: [entriesInjector],
  tools: [rememberTool, recallTool],
};

export default plugin;
