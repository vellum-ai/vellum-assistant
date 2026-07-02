# Hooks

Run your own code at fixed points in a turn. Hooks let a plugin read or transform what flows through the Assistant without forking the core loop.

A hook is a function that the Assistant calls at a known boundary in its lifecycle. The harness owns the loop, and your code runs at named points along the way. Each hook lives in its own file under `hooks/<name>.ts`, and the filename is the hook name.

Hooks load from two places. Inside a plugin they live under `<plugin>/hooks/<name>.ts`. You can also drop a **standalone hook** directly under `<workspace>/hooks/<name>.ts` — no `package.json`, no plugin scaffolding, just the hook file. Standalone workspace hooks behave identically to plugin hooks (same contexts, same `init`/`shutdown` lifecycle); for a given event, plugin hooks run first and the workspace hook runs last.

## The Agent Loop

The loop moves a conversation turn through a series of **lifecycle events**. The **hooks** are the places your code can run as the turn moves from one event to the next.

| Node            | What it means                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User prompt     | The incoming user message that kicks off a turn. The `user-prompt-submit` hook fires as the prompt enters the loop.                                                                           |
| Context check   | Decides whether the conversation fits within the model's context window. If it does not, control branches to Compaction before the model is called.                                           |
| Model call      | The inference request sent to the LLM. The `pre-model-call` hook fires immediately before the request is dispatched.                                                                          |
| Model response  | The raw output returned by the model. The `post-model-call` hook fires here, and the loop branches based on what the model returned: a tool call, a continuation, a stop, or a context error. |
| Assistant reply | The final message delivered to the user. The `stop` hook fires just before the reply is sent, marking the end of the turn.                                                                    |
| Compaction      | Summarizes or truncates older conversation history so the context fits within the model's window. The `post-compact` hook fires after compaction, and control returns to the Model call node. |
| Tool result     | The output of a tool execution. The `post-tool-use` hook fires here, and the result loops back to the merge junction for another model call.                                                  |

The loop can iterate several times within a single user turn: every tool result returns to a fresh model call, and a `post-model-call` hook can choose to continue rather than end the turn. Because of this, `pre-model-call`, `post-model-call`, and `post-tool-use` can each fire more than once per turn.

The Assistant also hooks into Lifecycle Events that sit outside the Agent Loop: `init` fires at bootstrap, and `shutdown` fires at teardown.

## Hooks reference

These are the lifecycle hooks. The full set of wired hook names lives in the [`HOOKS` constant](https://github.com/vellum-ai/vellum-assistant/blob/main/assistant/src/plugin-api/constants.ts).

### `init`

**Context:** `InitContext`
**When:** Once, when the plugin is first registered (on boot or install).
**Use it to:** Validate config and open resources. Throwing aborts the plugin's load.

| Field              | Type           | Access    | Description                                                                                            |
| ------------------ | -------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `config`           | `unknown`      | Read-only | Parsed config for this plugin, read from `<pluginDir>/config.json`.                                    |
| `pluginStorageDir` | `string`       | Read-only | Absolute path to `<pluginDir>/data/`, the plugin's writable data directory (created during bootstrap). |
| `assistantVersion` | `string`       | Read-only | Assistant semver, for defensive runtime checks.                                                        |
| `logger`           | `PluginLogger` | Read-only | Pino-compatible logger scoped to the plugin.                                                           |

### `user-prompt-submit`

**Context:** `UserPromptSubmitContext`
**When:** Once per user turn, after messages are assembled and before the agent loop runs.
**Use it to:** Read or rewrite the message list the model is about to see.
**Example:** [advisor](https://github.com/vellum-ai/vellum-assistant/blob/5a79f009573790dd085223a0133135410a6fe41d/assistant/src/plugins/defaults/advisor/hooks/user-prompt-submit.ts)

| Field              | Type                     | Access    | Description                                                                                                               |
| ------------------ | ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `conversationId`   | `string`                 | Read-only | Conversation the prompt was submitted on.                                                                                 |
| `userMessageId`    | `string`                 | Read-only | Persisted id of the user message that triggered the turn.                                                                 |
| `requestId`        | `string`                 | Read-only | Stable id for the request driving this turn.                                                                              |
| `modelProfileKey`  | `string`                 | Read-only | Effective inference profile identity for the model this turn will use. Profileless configs receive the resolved model id. |
| `isNonInteractive` | `boolean`                | Read-only | True when no human is present to answer clarifications (scheduled or headless runs).                                      |
| `prompt`           | `string`                 | Read-only | Resolved text of the user prompt, after slash-command expansion.                                                          |
| `originalMessages` | `ReadonlyArray<Message>` | Read-only | The user's original message list. Snapshot only, never mutate.                                                            |
| `latestMessages`   | `Message[]`              | Mutable   | The working list that flows into the agent loop. Mutate in place or replace via the return value.                         |
| `logger`           | `PluginLogger`           | Read-only | Logger scoped to the current turn.                                                                                        |

### `post-compact`

**Context:** `PostCompactContext`
**When:** After the loop compacts a conversation mid-turn, before the turn resumes. It fires on a compaction event rather than a fixed turn boundary, so it branches off the loop rather than sitting on a turn edge.
**Use it to:** Re-apply context that compaction dropped (for example memory injections) onto the compacted history before the next model call.
**Example:** [memory-v3-shadow](https://github.com/vellum-ai/vellum-assistant/blob/5a79f009573790dd085223a0133135410a6fe41d/assistant/src/plugins/defaults/memory-v3-shadow/hooks/post-compact.ts)

| Field              | Type                  | Access    | Description                                                                                                                                                   |
| ------------------ | --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history`          | `Message[]`           | Mutable   | The compacted message history to re-inject onto. The loop resumes the turn from the settled value.                                                            |
| `requestId`        | `string`              | Read-only | Stable id of the request driving this turn. Forward it onto the injector so re-applied blocks are attributed to the originating request.                      |
| `conversationId`   | `string`              | Read-only | Conversation the turn being compacted is scoped to.                                                                                                           |
| `isNonInteractive` | `boolean`             | Read-only | True when no human is present to answer clarifications (scheduled, background, or headless runs).                                                             |
| `modelProfileKey`  | `string`              | Read-only | Effective inference profile identity for the model the compacted turn will keep using. Profileless configs receive the resolved model id.                     |
| `injectionMode`    | `"full" \| "minimal"` | Read-only | Volume of runtime injection to re-apply. 'full' restores the complete context, 'minimal' is the reduced volume overflow recovery selects. Defaults to 'full'. |

### `pre-model-call`

**Context:** `PreModelCallContext`
**When:** Immediately before every provider call within a turn, including tool-result follow-ups.
**Use it to:** Edit the outbound request (for example the system prompt), route the call to a chosen inference profile, or defer this turn's live output stream.
**Example:** [advisor](https://github.com/vellum-ai/vellum-assistant/blob/5a79f009573790dd085223a0133135410a6fe41d/assistant/src/plugins/defaults/advisor/hooks/pre-model-call.ts)

| Field                  | Type                  | Access    | Description                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversationId`       | `string`              | Read-only | Conversation the call belongs to.                                                                                                                                                                                                                                                                                                                                |
| `callSite`             | `LLMCallSite \| null` | Read-only | Which call site this serves (`mainAgent` for the user-facing reply), or null when not tied to a known site. Self-gate on it before acting.                                                                                                                                                                                                                       |
| `systemPrompt`         | `string \| null`      | Mutable   | The system prompt about to be sent. Replace it to edit the request; guard the null case.                                                                                                                                                                                                                                                                         |
| `modelProfile`         | `string \| null`      | Mutable   | The inference profile this call routes to. Set it to a profile key to send the call there (the lever a model-router hook uses to pick a profile per call), or leave it as is for the default resolution. Seeded from the call's resolved override, and null when none applies. Gate on callSite first, and discover the routable keys with `getModelProfiles()`. |
| `deferAssistantOutput` | `boolean`             | Mutable   | Set true to suppress the live token stream so a post-model-call hook can emit the final text instead.                                                                                                                                                                                                                                                            |
| `logger`               | `PluginLogger`        | Read-only | Logger scoped to the current turn.                                                                                                                                                                                                                                                                                                                               |

### `post-model-call`

**Context:** `PostModelCallContext`
**When:** At every model-call outcome: a finalized assistant message, or a provider rejection. Fires once per model call, before a finalized reply is persisted and streamed.
**Use it to:** Transform the reply's text blocks (leave tool_use intact), and own the continue decision. On a degenerate no-tool reply or a recoverable rejection, repair the history and set decision to continue to re-query the model.
**Example:** [advisor](https://github.com/vellum-ai/vellum-assistant/blob/5a79f009573790dd085223a0133135410a6fe41d/assistant/src/plugins/defaults/advisor/hooks/post-model-call.ts)

| Field            | Type                    | Access    | Description                                                                                                                                                                                                                                                       |
| ---------------- | ----------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversationId` | `string`                | Read-only | Conversation the message belongs to.                                                                                                                                                                                                                              |
| `callSite`       | `LLMCallSite \| null`   | Read-only | Which call site this message serves, or null when not tied to a known site. Self-gate before acting.                                                                                                                                                              |
| `content`        | `ContentBlock[]`        | Mutable   | The finalized message content; empty on a provider rejection. Transform text blocks and leave tool_use intact.                                                                                                                                                    |
| `messages`       | `Message[]`             | Mutable   | Full conversation history. When continuing, leave this as the history the next iteration should send (append a follow-up turn, or replace it with a repaired one).                                                                                                |
| `error`          | `Error \| undefined`    | Read-only | The provider rejection that ended the call, on a rejection outcome; absent on a finalized reply. Hooks that only act on a real reply should guard on it and return early.                                                                                         |
| `stopReason`     | `string \| null`        | Read-only | Provider-reported stop reason, or null when none was reported (also null on a rejection).                                                                                                                                                                         |
| `decision`       | `PostModelCallDecision` | Mutable   | Seeded to 'stop'. Set it to 'continue' to re-query the model. Honored only at actionable outcomes (a no-tool reply or a provider rejection); the loop does not gate it on call site, so self-gate via callSite to avoid re-querying background or subagent calls. |
| `logger`         | `PluginLogger`          | Read-only | Logger scoped to the current turn.                                                                                                                                                                                                                                |

### `post-tool-use`

**Context:** `PostToolUseContext`
**When:** After each tool returns, before the result rejoins the history sent to the provider.
**Use it to:** Transform the tool result, for example truncating oversized output to fit the context window.
**Example:** [tool-result-truncate](https://github.com/vellum-ai/vellum-assistant/blob/5a79f009573790dd085223a0133135410a6fe41d/assistant/src/plugins/defaults/tool-result-truncate/hooks/post-tool-use.ts)

| Field               | Type                     | Access    | Description                                                                                                                              |
| ------------------- | ------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `conversationId`    | `string`                 | Read-only | Conversation the tool ran on.                                                                                                            |
| `toolResponse`      | `ToolResultContent`      | Mutable   | The tool result block. Mutate its content in place or replace the block.                                                                 |
| `messages`          | `ReadonlyArray<Message>` | Read-only | History up to and including the assistant turn that issued the call. The result is not in it yet.                                        |
| `additionalContext` | `string \| null`         | Mutable   | Extra model-only guidance appended after the tool result, for example retry coaching. Defaults to null; set a string to append guidance. |
| `maxInputTokens`    | `number`                 | Read-only | The model's context-window size in tokens, for deriving a character budget.                                                              |
| `logger`            | `PluginLogger`           | Read-only | Logger scoped to the current turn.                                                                                                       |

### `stop`

**Context:** `StopContext`
**When:** Once per run, when the loop has committed to ending the turn. Fires on every terminal exit (a no-tool reply, max tokens, a yield to the user, exhausted overflow recovery, an abort, or an error) and on a checkpoint handoff.
**Use it to:** Run teardown: release per-turn resources or clear per-turn state, knowing nothing will re-enter the loop this run. It cannot continue the loop; the retry decision lives in post-model-call.
**Example:** [max-tokens-continue](https://github.com/vellum-ai/vellum-assistant/blob/5a79f009573790dd085223a0133135410a6fe41d/assistant/src/plugins/defaults/max-tokens-continue/hooks/stop.ts)

| Field            | Type                     | Access    | Description                                                                                                                                                                                |
| ---------------- | ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `conversationId` | `string`                 | Read-only | Conversation the run belongs to.                                                                                                                                                           |
| `messages`       | `ReadonlyArray<Message>` | Read-only | Full conversation history at the terminal stop. Provided for inspection; mutating it has no effect, since the loop will not run again this turn.                                           |
| `exitReason`     | `AgentLoopExitReason`    | Read-only | Which terminal state the turn reached (for example `no_tool_calls`, `max_tokens_reached`, `error`, `checkpoint_handoff`). A hook that should act only on a particular ending guards on it. |
| `error`          | `Error \| undefined`     | Read-only | The rejection that ended the turn, when it ended on one; absent on a clean stop.                                                                                                           |
| `logger`         | `PluginLogger`           | Read-only | Logger scoped to the current turn.                                                                                                                                                         |

### `shutdown`

**Context:** `ShutdownContext`
**When:** Once, when the Assistant tears down the plugin (process exit, unload).
**Use it to:** Best-effort cleanup. Do not rely on it for critical writes; persist durably during normal operation instead.

| Field              | Type     | Access    | Description                                        |
| ------------------ | -------- | --------- | -------------------------------------------------- |
| `assistantVersion` | `string` | Read-only | Assistant semver, for version-conditional cleanup. |

When several plugins register hooks for the same boundary, they chain: each hook sees the previous hook's changes, and the merged result flows into the next. The order is deterministic.

## Resolution order

When multiple plugins define the same hook, they execute in a fixed order so the chain is predictable:

1. **Built-in default plugins.** Registered explicitly at startup. They always run first, so their context transformations are visible to every user plugin after them.
2. **User plugins.** Ordered by the plugin's original install date, the `installedAt` timestamp from the `install-meta.json` sidecar written at install time. Plugins installed earlier run first. Plugins without a sidecar fall back to the directory creation time and sort after dated ones.

Within a single plugin, hooks for the same name are not duplicated: each plugin contributes at most one hook per boundary. The chain is linear: the output of hook N is the input of hook N+1, and the final output is what the Assistant acts on.

## @vellumai/plugin-api exports for hooks

These are the hook-related exports from [`@vellumai/plugin-api`](https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api). Each context type's full field contract is documented in the hook sections above.

| Export                    | Kind  | Purpose                                                                                                                           |
| ------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| `HOOKS`                   | const | Wired hook names keyed by constant (INIT, PRE_MODEL_CALL, and so on). Reference hooks by this instead of free-form strings.       |
| `HookName`                | type  | Union of every wired hook name declared in HOOKS.                                                                                 |
| `HookFunction`            | type  | Signature every hook implements: `(ctx) => Promise<Partial<ctx> \| void>`.                                                        |
| `InitContext`             | type  | Passed to the init hook at bootstrap.                                                                                             |
| `ShutdownContext`         | type  | Passed to the shutdown hook at teardown.                                                                                          |
| `UserPromptSubmitContext` | type  | Passed to user-prompt-submit, before a turn's messages reach the agent loop.                                                      |
| `PreModelCallContext`     | type  | Passed to pre-model-call, before each provider call.                                                                              |
| `PostToolUseContext`      | type  | Passed to post-tool-use, once per tool result.                                                                                    |
| `PostModelCallContext`    | type  | Passed to post-model-call at every model-call outcome (a finalized reply or a provider rejection); carries the continue decision. |
| `PostCompactContext`      | type  | Passed to post-compact, after the loop compacts a conversation mid-turn.                                                          |
| `StopContext`             | type  | Passed to stop, the terminal hook, once the turn has committed to ending.                                                         |
| `PostModelCallDecision`   | type  | The post-model-call decision shape: whether to end the turn or continue.                                                          |
| `AgentLoopExitReason`     | type  | Which terminal state a turn reached, carried on StopContext.                                                                      |

## Anatomy of a hook

Every hook has the same shape: it receives a typed context and either mutates it in place and returns nothing, or returns a **partial** context. A returned partial is merged onto the threaded context - only the keys it includes are overwritten, every other field is preserved - so a hook can edit just the subset of fields it cares about without re-specifying the rest. The runtime threads the merged context to the next plugin and then to the Assistant.

```ts
type HookFunction<TCtx> = (ctx: TCtx) => Promise<Partial<TCtx> | void>;
```

Because an omitted key means "keep the existing value", every context field is required and uses `| null` rather than `?` or `| undefined`: a present key always carries a concrete value, so a field absent from a returned partial is never ambiguous with one a hook meant to clear.

One hook per file, default-exported. The filename becomes the hook key, so a `pre-model-call` hook is `hooks/pre-model-call.ts`:

```ts
// hooks/pre-model-call.ts
import type { PreModelCallContext } from "@vellumai/plugin-api";

export default async function preModelCall(
  ctx: PreModelCallContext,
): Promise<void> {
  // Only touch the user-facing reply, not background or subagent calls.
  if (ctx.callSite !== "mainAgent") {
    return;
  }
  ctx.systemPrompt = (ctx.systemPrompt ?? "") + "\nBe concise.";
}
```

Context types and constants come from [`@vellumai/plugin-api`](https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api), the only supported contract.
