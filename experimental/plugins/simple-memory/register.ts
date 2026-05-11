/**
 * Simple Memory — Phase 0 experimental plugin.
 *
 * Purpose: prove out the agent-plugin-system contract by wiring **every** hook
 * a memory system would need against the runtime, with the thinnest possible
 * implementation behind each one. The actual memory logic is intentionally
 * stubbed — Phase 1+ will move real behavior into the runtime harness
 * directly and this plugin will be the canary that the harness still calls
 * through the documented seams.
 *
 * ## Hooks wired
 *
 * | Capability                     | Plugin field            | What it does today                                                                     | What it will do later                                                              |
 * |--------------------------------|-------------------------|----------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------|
 * | Read memory at turn-start      | `middleware.memoryRetrieval` | Calls `next(args)` then merges in any entries we've remembered for the conversation.   | Replaces the default retriever entirely with a graph/vector lookup.                |
 * | Inject memory into the prompt  | `injectors[]`           | Emits a `<simple_memory>` block listing the conversation's remembered entries.         | Renders structured sections (essentials/threads/recent/buffer) like Apollo's own.  |
 * | Observe writes after a turn    | `middleware.persistence` | Passes through, logs the count of persisted messages so we can confirm the hook fires. | Distills the turn into memory write candidates and appends them to the store.      |
 * | Model-visible remember/recall  | `tools[]`               | Two tools (`simple_memory_remember`, `simple_memory_recall`) that read/write the store.| Same surface, real ranking + decay + consolidation behind it.                      |
 * | Setup / teardown               | `init` / `onShutdown`   | Opens a JSONL file under `pluginStorageDir`, parses prior entries, flushes on shutdown.| Mounts the real backing store (sqlite / qdrant / graph) here.                      |
 *
 * ## Imports are REPO-LOCAL (same caveat as the echo example)
 *
 * The relative imports below resolve only while this file lives at
 * `experimental/plugins/simple-memory/register.ts` inside the
 * vellum-assistant repo. To install elsewhere, symlink the directory into
 * `<workspaceDir>/plugins/simple-memory/`. See `README.md` for the recipe.
 *
 * Design doc: `.private/plans/agent-plugin-system.md`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { RiskLevel } from "../../../packages/skill-host-contracts/src/tool-types.js";
import { registerPlugin } from "../../../assistant/src/plugins/registry.js";
import type {
  InjectionBlock,
  Injector,
  MemoryArgs,
  MemoryResult,
  Middleware,
  PersistArgs,
  PersistResult,
  Plugin,
  PluginInitContext,
  PluginToolRegistration,
  TurnContext,
} from "../../../assistant/src/plugins/types.js";

const PLUGIN_NAME = "simple-memory";

// ─── In-memory store ─────────────────────────────────────────────────────────
//
// Phase 0 keeps everything in process. `init()` hydrates from a JSONL file on
// `pluginStorageDir`; `onShutdown()` flushes the same path. Each entry is
// scoped to a `conversationId` so retrieval/injection can filter — the real
// memory system will replace this with a proper backing store.

interface MemoryEntry {
  readonly id: string;
  readonly conversationId: string;
  readonly text: string;
  /** Epoch milliseconds when the entry was written. */
  readonly createdAt: number;
}

interface PluginState {
  /** Resolved path to the JSONL file backing the in-memory store. */
  storePath: string;
  /** All entries in memory, append-order. */
  entries: MemoryEntry[];
  /** Pino-compatible child logger handed to us by the bootstrap. */
  logger: PinoLike;
}

/**
 * Minimal logger shape so this file doesn't pull pino as a dep. The
 * bootstrap hands us a child logger; we only use the `info`/`debug`/`error`
 * methods.
 */
interface PinoLike {
  info(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

let state: PluginState | null = null;

function requireState(): PluginState {
  if (state === null) {
    throw new Error(
      `${PLUGIN_NAME}: plugin state not initialized — was init() called?`,
    );
  }
  return state;
}

// ─── init / onShutdown ───────────────────────────────────────────────────────

async function init(ctx: PluginInitContext): Promise<void> {
  const logger = ctx.logger as PinoLike;
  const storePath = path.join(ctx.pluginStorageDir, "entries.jsonl");
  await fs.mkdir(ctx.pluginStorageDir, { recursive: true });

  const entries: MemoryEntry[] = [];
  try {
    const raw = await fs.readFile(storePath, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        entries.push(JSON.parse(line) as MemoryEntry);
      } catch (err) {
        logger.error(
          { plugin: PLUGIN_NAME, line, err: String(err) },
          "skipping malformed entries.jsonl line",
        );
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
    // First boot — no file yet. Leave entries empty.
  }

  state = { storePath, entries, logger };
  logger.info(
    {
      plugin: PLUGIN_NAME,
      storePath,
      hydratedEntries: entries.length,
    },
    "simple-memory initialized",
  );
}

async function onShutdown(): Promise<void> {
  if (state === null) return;
  const { storePath, entries, logger } = state;
  const serialized = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  await fs.writeFile(storePath, entries.length === 0 ? "" : serialized, "utf8");
  logger.info(
    { plugin: PLUGIN_NAME, storePath, flushedEntries: entries.length },
    "simple-memory shutdown",
  );
  state = null;
}

// ─── Store helpers ───────────────────────────────────────────────────────────

function entriesFor(conversationId: string): MemoryEntry[] {
  return requireState().entries.filter(
    (e) => e.conversationId === conversationId,
  );
}

function appendEntry(entry: MemoryEntry): void {
  requireState().entries.push(entry);
}

function newEntryId(): string {
  return `sm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── memoryRetrieval middleware ──────────────────────────────────────────────
//
// The default retriever (assistant/src/plugins/defaults/memory-retrieval.ts)
// remains the terminal — we observe it, then merge our own entries into the
// downstream `MemoryResult` so the agent loop sees both. Phase 1 will likely
// short-circuit `next(args)` and become the sole retriever.

const memoryRetrieval: Middleware<MemoryArgs, MemoryResult> =
  async function simpleMemoryRetrieval(
    args: MemoryArgs,
    next: (args: MemoryArgs) => Promise<MemoryResult>,
    _ctx: TurnContext,
  ): Promise<MemoryResult> {
    const downstream = await next(args);

    // Phase 0: we don't synthesize any `memoryGraphBlocks` because the agent
    // loop narrows on `DEFAULT_MEMORY_GRAPH_KIND` and we don't want to
    // confuse that path. Our contribution rides on the injector instead.
    //
    // Phase 1 will likely:
    //   - skip `next(args)` entirely,
    //   - run our own retrieval (qdrant/sqlite/whatever),
    //   - emit a `memoryGraphBlocks` entry with a custom `kind` discriminator,
    //   - and update the agent loop to consume it.
    const ours = entriesFor(args.conversationId);
    requireState().logger.debug(
      {
        plugin: PLUGIN_NAME,
        conversationId: args.conversationId,
        turnIndex: args.turnIndex,
        defaultGraphBlocks: downstream.memoryGraphBlocks.length,
        simpleMemoryEntries: ours.length,
      },
      "memoryRetrieval observed",
    );
    return downstream;
  };

// ─── Injector ────────────────────────────────────────────────────────────────
//
// Order 25 slots us between the default unified turn-context injector (10)
// and the default PKB injector (~30). We append after any memory-prefix
// blocks so we land in the canonical memory ordering — same convention the
// default injectors use.

const simpleMemoryInjector: Injector = {
  name: `${PLUGIN_NAME}/entries`,
  order: 25,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const ours = entriesFor(ctx.conversationId);
    if (ours.length === 0) return null;
    const body = ours
      .map((e) => `- [${new Date(e.createdAt).toISOString()}] ${e.text}`)
      .join("\n");
    return {
      id: `${PLUGIN_NAME}/entries`,
      text: `<simple_memory>\n${body}\n</simple_memory>`,
      placement: "after-memory-prefix",
      meta: { plugin: PLUGIN_NAME, count: ours.length },
    };
  },
};

// ─── persistence observer ────────────────────────────────────────────────────
//
// Pure pass-through today. Phase 1 will inspect what was persisted and
// distill it into memory write candidates (the same way Apollo's memory
// agent does after every turn).

const persistence: Middleware<PersistArgs, PersistResult> =
  async function simpleMemoryPersistence(
    args: PersistArgs,
    next: (args: PersistArgs) => Promise<PersistResult>,
    ctx: TurnContext,
  ): Promise<PersistResult> {
    const result = await next(args);
    requireState().logger.debug(
      {
        plugin: PLUGIN_NAME,
        conversationId: ctx.conversationId,
        turnIndex: ctx.turnIndex,
      },
      "persistence observed",
    );
    return result;
  };

// ─── Tools ───────────────────────────────────────────────────────────────────
//
// Two model-visible tools. `simple_memory_remember` appends to the store;
// `simple_memory_recall` reads it back. The model can use these explicitly
// (e.g. "remember that the user prefers ET") and they're the same surface
// Phase 1's automated distillation will write through.
//
// `category: "plugin"` matches the docs example; both run with low default
// risk because they only mutate plugin-scoped state.

const rememberTool: PluginToolRegistration = {
  name: "simple_memory_remember",
  description:
    "Append a freeform note to simple-memory for the current conversation. Use when the user states a stable preference, a fact about themselves, or a decision worth carrying across turns.",
  category: "plugin",
  defaultRiskLevel: RiskLevel.Low,
  getDefinition: () => ({
    name: "simple_memory_remember",
    description:
      "Append a freeform note to simple-memory for the current conversation.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The note to remember. One sentence, written naturally.",
        },
      },
      required: ["text"],
    },
  }),
  execute: async (input, toolCtx) => {
    const text = String((input as { text?: unknown }).text ?? "").trim();
    if (text.length === 0) {
      return { content: "error: text must be non-empty", isError: true };
    }
    const entry: MemoryEntry = {
      id: newEntryId(),
      conversationId: toolCtx.conversationId,
      text,
      createdAt: Date.now(),
    };
    appendEntry(entry);
    requireState().logger.info(
      {
        plugin: PLUGIN_NAME,
        conversationId: entry.conversationId,
        entryId: entry.id,
      },
      "remembered entry",
    );
    return { content: `remembered (${entry.id})`, isError: false };
  },
};

const recallTool: PluginToolRegistration = {
  name: "simple_memory_recall",
  description:
    "Return every simple-memory entry written for the current conversation. Use when you need to recall what was remembered earlier in this conversation.",
  category: "plugin",
  defaultRiskLevel: RiskLevel.Low,
  getDefinition: () => ({
    name: "simple_memory_recall",
    description: "Return every simple-memory entry for the current conversation.",
    input_schema: { type: "object", properties: {}, required: [] },
  }),
  execute: async (_input, toolCtx) => {
    const ours = entriesFor(toolCtx.conversationId);
    if (ours.length === 0) {
      return { content: "no entries", isError: false };
    }
    const body = ours
      .map((e) => `${e.id}\t${new Date(e.createdAt).toISOString()}\t${e.text}`)
      .join("\n");
    return { content: body, isError: false };
  },
};

// ─── Plugin ──────────────────────────────────────────────────────────────────

const simpleMemoryPlugin: Plugin = {
  manifest: {
    name: PLUGIN_NAME,
    version: "0.0.1",
    provides: {},
    requires: { pluginRuntime: "v1" },
    // No requiresFlag yet — Phase 0 activates unconditionally when installed.
    // Phase 1 will likely gate behind an assistant feature flag once it
    // starts competing with the default memory graph.
  },
  init,
  onShutdown,
  middleware: {
    memoryRetrieval,
    persistence,
  },
  injectors: [simpleMemoryInjector],
  tools: [rememberTool, recallTool],
};

// Side-effect registration — see echo/register.ts for the contract.
registerPlugin(simpleMemoryPlugin);
