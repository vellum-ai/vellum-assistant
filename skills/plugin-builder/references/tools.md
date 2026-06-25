# Tools

Add new actions the model can call. A plugin tool lands in the same catalog as the Assistant's built-in tools, so the model picks it up with no extra wiring.

A tool is a default-exported object from `tools/<name>.ts`. The loader derives the model-visible tool name from the file basename, so `tools/example.ts` becomes the `example` tool. Plugin tools register in the same catalog as built-in tools and are offered to the model through the standard tool-calling interface.

## What a tool is

A tool is something the model chooses to call. You describe what it does and what arguments it takes, and the model decides when to invoke it. When it does, the Assistant runs your `execute` function and feeds the result back into the turn.

Every field on a tool definition is optional. The loader fills documented defaults for anything you omit, so `export default {}` is a valid (if useless) tool. A broken or misconfigured tool never blocks the rest of the plugin from loading; the problem surfaces at call time instead.

## Tool reference

These are the fields a tool definition can set. Names and types come from `ToolDefinition` in [`@vellumai/plugin-api`](https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api).

| Field              | Type                                           | Default                | Description                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | `string`                                       | File basename          | Name the model sees when calling the tool. Loaders default to the source file basename, so `tools/example.ts` becomes `example`. Only set this to override the file-derived name.                                           |
| `description`      | `string`                                       | `""`                   | Human-readable description shown to the model in the tool catalog. This is how the model decides when to call the tool, so write it for the model.                                                                          |
| `input_schema`     | `object (JSON Schema)`                         | Empty object schema    | JSON Schema describing the tool's input arguments. The model is constrained to this shape when it calls the tool.                                                                                                           |
| `defaultRiskLevel` | `"low" \| "medium" \| "high"`                  | `"medium"`             | Author-asserted risk band that drives default permission gating. The medium default prompts the user, then allows on first invocation.                                                                                      |
| `category`         | `string`                                       | None                   | Tool category used for channel-scoped `allowedToolCategories` enforcement.                                                                                                                                                  |
| `executionTarget`  | `"sandbox" \| "host"`                          | Resolved automatically | Where the tool runs: the sandbox (assistant container) or the host (guardian device, via proxy). When omitted, resolved by name prefix: `host_*` and `computer_use_*` default to host, everything else defaults to sandbox. |
| `execute`          | `(input, ctx) => Promise<ToolExecutionResult>` | Unimplemented error    | Implementation invoked when the model calls the tool. When omitted, the loader synthesizes a result that reports the tool as unimplemented.                                                                                 |

**Execution target naming.** When `executionTarget` is omitted, the runtime resolves it by tool name: names starting with `host_` or `computer_use_` run on the host; everything else runs in the sandbox. This means `host_my_thing` executes on the guardian's device, while `my_host_thing` executes in the assistant container. To run on the host without a `host_` prefix, set `executionTarget: "host"` explicitly.

### The execute context

`execute(input, ctx)` receives the model-supplied `input` (validated against your `input_schema`) and a `ToolContext`, and returns a `ToolExecutionResult`. The complete `ToolContext` plugin and workspace tools receive is listed below — a small, stable surface.

| Field            | Type                       | Description                                                                                                             |
| ---------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `conversationId` | `string`                   | Conversation this tool invocation belongs to.                                                                         |
| `workingDir`     | `string`                   | Working directory the assistant was launched from.                                                                    |
| `requestId`      | `string?`                  | Per-turn request id for cross-component log correlation.                                                              |
| `signal`         | `AbortSignal?`             | Cooperative cancellation. Check `signal.aborted` periodically, or forward it to `fetch` and child-process options.    |
| `onOutput`       | `(chunk: string) => void?` | Incremental-output callback for streaming tools. Fall back to returning the full result in `content` when it is absent. |
| `assistantId`    | `string?`                  | Logical assistant scope for multi-assistant routing.                                                                  |
| `isInteractive`  | `boolean?`                 | True when an interactive client is connected (not just a no-op callback).                                            |

> **Breaking change (plugins in beta).** `ToolContext` was deliberately slimmed to the fields above. It previously also carried routing, permission, trust, requester-identity, and proxy metadata (`trustClass`, `requestSecret`, `sendToClient`, `allowedToolNames`, `executionChannel`, `transportInterface`, and similar). Those fields are legacy host internals — they now live on a separate `CoreToolContext` that only built-in core, skill, and MCP tools receive, and are **no longer available to plugin or workspace tools**. We are removing them from the host surface over time, so plugin and workspace tools should not depend on them.

The result is what the model sees back:

| Field           | Type              | Description                                                                                             |
| --------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `content`       | `string`          | Text result shown to the model in the tool-result block. An empty string is valid.                      |
| `isError`       | `boolean`         | When true, the agent loop treats content as an error and may surface it or retry.                       |
| `status`        | `string?`         | Short status message for client display, such as "truncated" or "timed out".                            |
| `yieldToUser`   | `boolean?`        | When true, the loop returns control to the user after this result instead of making another model call. |
| `contentBlocks` | `ContentBlock[]?` | Rich content blocks (for example images) to include alongside the text result.                          |

## Resolution order

All tools (built-in, plugin, workspace, and MCP) land in one shared catalog. When the model calls a tool, the runtime looks it up by name. When two sources register the same name, the higher-precedence source wins:

1. **Core tools.** Registered at startup. They take precedence over plugin and MCP tools: a plugin or MCP tool with the same name is skipped with a warning.
2. **Workspace tools.** Filesystem overrides under `/workspace/tools/`. These are the explicit exception to registration order: a workspace override always shadows a core tool of the same name, regardless of when it was discovered.
3. **MCP server tools.** Registered when an MCP server connects. Conflicts with core or workspace tools are skipped; conflicts with plugin tools are resolved by first registration.
4. **Built-in default plugin tools.** Vellum ships a set of default plugins alongside the Assistant. Their tools register during bootstrap, before any user-installed plugin tools.
5. **User plugin tools.** Registered at boot, ordered by the plugin's original install date (same ordering as hooks: `install-meta.json` -> directory birthtime -> unknown). A user plugin tool that collides with a core, workspace, MCP, or default plugin tool is skipped. A collision between two different user plugins with the same tool name fails registration.

The model sees the full catalog regardless of source. Pick distinctive tool names to avoid collisions. The loader derives the name from the file basename, so namespacing with a prefix (for example `myplugin_search`) is the simplest way to stay clear.

## @vellumai/plugin-api exports for tools

These are the tool-related exports from [`@vellumai/plugin-api`](https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api). The full field contracts are documented in the sections above.

| Export                | Kind | Purpose                                                                         |
| --------------------- | ---- | ------------------------------------------------------------------------------- |
| `ToolDefinition`      | type | Author-facing tool spec, the default-export shape for a `tools/<name>.ts` file. |
| `ToolContext`         | type | Runtime context passed as the second argument to a tool's execute.              |
| `ToolExecutionResult` | type | Return shape of a tool's execute: `{ content, isError }`.                       |
| `RiskLevel`           | enum | Risk bands (low, medium, high) that drive default permission gating for a tool. |

## Anatomy of a tool

One tool per file, default-exported. The filename becomes the tool name, so an `example` tool is `tools/example.ts`:

```ts
// tools/example.ts
import type { ToolContext, ToolExecutionResult } from "@vellumai/plugin-api";

export default {
  description:
    "Search saved notes for a phrase. Use this when the user asks what they told you to remember.",
  defaultRiskLevel: "low" as const,
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to search for." },
    },
    required: ["query"],
  },
  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const query = String((input as { query?: unknown }).query ?? "").trim();
    if (query.length === 0) {
      return { content: "error: query must be non-empty", isError: true };
    }
    // ctx.conversationId - current conversation
    // ctx.signal         - forward to fetch() / spawn() for cancellation
    return {
      content: `searched ${ctx.conversationId} for ${query}`,
      isError: false,
    };
  },
};
```

Types come from [`@vellumai/plugin-api`](https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api), the only supported contract.
