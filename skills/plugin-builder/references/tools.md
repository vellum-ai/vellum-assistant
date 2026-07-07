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

`execute(input, ctx)` receives the model-supplied `input` (validated against your `input_schema`) and a `ToolContext`, and returns a `ToolExecutionResult`. The complete `ToolContext` is listed below. Most tools only reach for the first few fields; the rest carry routing, permission, and trust metadata the host threads through, and the surface is still being narrowed while plugins are in beta.

| Field                           | Type                                       | Description                                                                                                                   |
| ------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `conversationId`                | `string`                                   | Conversation this tool invocation belongs to.                                                                                 |
| `workingDir`                    | `string`                                   | Working directory the assistant was launched from.                                                                            |
| `requestId`                     | `string?`                                  | Per-turn request id for cross-component log correlation.                                                                      |
| `signal`                        | `AbortSignal?`                             | Cooperative cancellation. Check `signal.aborted` periodically, or forward it to `fetch` and child-process options.            |
| `onOutput`                      | `(chunk: string) => void?`                 | Incremental-output callback for streaming tools. Fall back to returning the full result in `content` when it is absent.       |
| `assistantId`                   | `string?`                                  | Logical assistant scope for multi-assistant routing.                                                                          |
| `taskRunId`                     | `string?`                                  | Set when the execution is part of a task run; used to retrieve ephemeral permission rules.                                    |
| `skillId`                       | `string?`                                  | Id of the skill whose `skill_execute` dispatch triggered this invocation. Absent for direct (non-skill) tool calls.           |
| `onToolLifecycleEvent`          | `ToolLifecycleEventHandler?`               | Callback for tool lifecycle events (start, prompt, deny, execute, error).                                                     |
| `proxyToolResolver`             | `ProxyToolResolver?`                       | Resolver for proxy tools; delegates execution to an external client.                                                          |
| `allowedToolNames`              | `Set<string>?`                             | When set, only tools in this set may execute; others are blocked with an error.                                               |
| `diskPressureCleanupModeActive` | `boolean?`                                 | True when the turn is restricted to storage cleanup-safe tools.                                                               |
| `requestSecret`                 | `(params) => Promise<SecretPromptResult>?` | Prompt the user for a secret value via the native SecureField UI.                                                             |
| `sendToClient`                  | `(msg) => void?`                           | Send a message to the connected client (for example, `open_url`).                                                             |
| `isInteractive`                 | `boolean?`                                 | True when an interactive client is connected (not just a no-op callback).                                                     |
| `forcePromptSideEffects`        | `boolean?`                                 | When true, tools with side effects should always prompt for confirmation.                                                     |
| `requireFreshApproval`          | `boolean?`                                 | When true, every invocation needs a fresh interactive approval; no cached grants or auto-approve shortcuts bypass the prompt. |
| `proxyApprovalCallback`         | `ProxyApprovalCallback?`                   | Approval callback for proxy policy decisions that require user confirmation.                                                  |
| `principal`                     | `string?`                                  | Principal identifier propagated to sub-tool confirmation flows.                                                               |
| `trustClass`                    | `TrustClass`                               | Trust classification of the initiating actor; determines permission level (guardian, trusted contact, unknown).               |
| `executionChannel`              | `string?`                                  | Channel the invocation originates through (for example telegram, phone). Used for scoped grant consumption.                   |
| `callSessionId`                 | `string?`                                  | Voice/call session id when the invocation originates from a call. Used for scoped grant consumption.                          |
| `triggeredBySurfaceAction`      | `boolean?`                                 | True when the invocation was triggered by a user clicking a surface action button.                                            |
| `approvedViaPrompt`             | `boolean?`                                 | True when the user explicitly approved this invocation via the interactive permission prompt.                                 |
| `batchAuthorizedByTask`         | `boolean?`                                 | True when a scheduled task run pre-authorized this tool via its `required_tools` array.                                       |
| `requesterExternalUserId`       | `string?`                                  | External user id of the requester (non-guardian actor). Used for scoped grant consumption.                                    |
| `requesterChatId`               | `string?`                                  | Chat id of the requester (non-guardian actor). Used for grant request escalation notifications.                               |
| `requesterIdentifier`           | `string?`                                  | Human-readable identifier for the requester (for example @username).                                                          |
| `requesterDisplayName`          | `string?`                                  | Preferred display name for the requester.                                                                                     |
| `channelPermissionChannelId`    | `string?`                                  | Slack channel id for channel-scoped permission enforcement.                                                                   |
| `toolUseId`                     | `string?`                                  | The tool_use block id from the LLM response, used to correlate confirmation prompts with invocations.                         |
| `isPlatformHosted`              | `boolean?`                                 | True when the assistant runs as a platform-managed remote instance. Used to auto-approve sandboxed bash tools.                |
| `transportInterface`            | `InterfaceId?`                             | Interface id of the connected client driving the turn (for example macos, chrome-extension).                                  |
| `overrideProfile`               | `string?`                                  | Per-turn inference-profile override, forwarded when spawning nested subagents.                                                |
| `sourceActorPrincipalId`        | `string?`                                  | Canonical principal id of the actor on whose behalf the invocation runs.                                                      |

The result is what the model sees back:

| Field           | Type              | Description                                                                                             |
| --------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `content`       | `string`          | Text result shown to the model in the tool-result block. An empty string is valid.                      |
| `isError`       | `boolean`         | When true, the agent loop treats content as an error and may surface it or retry.                       |
| `status`        | `string?`         | Short status message for client display, such as "truncated" or "timed out".                            |
| `yieldToUser`   | `boolean?`        | When true, the loop returns control to the user after this result instead of making another model call. |
| `contentBlocks` | `ContentBlock[]?` | Rich content blocks (for example images) to include alongside the text result.                          |

## Persisting data from a tool

A tool that needs durable storage should derive the directory from the workspace root, which matches where the host provisions plugin storage (`<workspaceDir>/plugins/<plugin-name>/data`):

```ts
execute: async (input, ctx) => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const storageDir = path.join(process.env.VELLUM_WORKSPACE_DIR, "plugins", "my-plugin-name", "data");
  await fs.mkdir(storageDir, { recursive: true });
  // read/write files under storageDir
},
```

Note that `pluginStorageDir` is only available on `InitContext` (the `init` hook), not on `ToolContext`, so a tool cannot read it inside `execute`.

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

