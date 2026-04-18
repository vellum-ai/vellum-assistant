# Error Handling Conventions

> Referenced from the root [AGENTS.md](../../AGENTS.md). This is the canonical location for error handling patterns.

Use the right error signaling mechanism for the situation. The codebase has three patterns — pick the one that matches the failure mode:

## 1. Throw for programming errors and unrecoverable failures

Throw an exception (using the error hierarchy from `util/errors.ts`) when:

- A precondition or invariant is violated (indicates a bug in the caller).
- The failure is unrecoverable and the caller cannot meaningfully continue.
- An external dependency is completely unavailable and there is no fallback.

Use the existing `VellumError` hierarchy (`ToolError`, `ConfigError`, `ProviderError`, etc.) rather than bare `Error`. This ensures structured error codes propagate to logging and monitoring.

```typescript
// Good: typed error for a precondition violation
throw new ConfigError("Missing required provider configuration");

// Good: subagent manager throws when depth limit is exceeded
throw new AssistantError(
  "Cannot spawn subagent: parent is itself a subagent",
  ErrorCode.DAEMON_ERROR,
);
```

## 2. Result objects for operations that can fail in expected ways

Return a discriminated union or result object when:

- The caller is expected to handle both success and failure paths.
- The failure is a normal operational outcome, not a bug (e.g., "file not found", "path out of bounds", "ambiguous match").

The codebase uses two result patterns — both are acceptable:

**Discriminated union with `ok` flag** (preferred for new code):

```typescript
type EditResult =
  | { ok: true; updatedContent: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; matchCount: number };
```

**Content + error flag** (used by tool execution):

```typescript
interface ToolExecutionResult {
  content: string;
  isError: boolean;
}
```

Existing examples: `EditEngineResult` in `edit-engine.ts`, `PathResult` in `path-policy.ts`, `ToolExecutionResult` in `tools/types.ts`, `MemoryRecallResult` in `memory/retriever.ts`.

## 3. Never return null/undefined to indicate failure

Do not use `null` or `undefined` as a failure signal. When a function can legitimately fail, use a result object (pattern 2 above) so the caller can distinguish between "no result" and "operation failed, here's why."

Returning `undefined` is acceptable only for **lookup functions** where "not found" is a normal query result rather than a failure — e.g., `Map.get()`, `getState(id): State | undefined`. In these cases, `undefined` means "this entity does not exist," not "something went wrong."

## Where each pattern is used

| Module                                                | Pattern                                                                         | Rationale                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Agent loop (`agent/loop.ts`)                          | Throws + catch-and-emit                                                         | Unrecoverable provider errors break the loop; expected errors (abort, tool-use limits) are caught and emitted as events        |
| Tool executor (`tools/executor.ts`)                   | Result object (`ToolExecutionResult`)                                           | Tool failures are expected operational outcomes — permission denied, unknown tool, sandbox violations. Never throws to callers |
| Memory retriever (`memory/retriever.ts`)              | Result object (`MemoryRecallResult`) with degraded/reason fields                | Graceful degradation — embedding failures, search failures degrade quality without crashing                                    |
| Filesystem tools (`path-policy.ts`, `edit-engine.ts`) | Discriminated union (`{ ok, reason }`)                                          | Validation outcomes that the caller must handle (out of bounds, not found, ambiguous)                                          |
| Subagent manager (`subagent/manager.ts`)              | Throws for precondition violations, string literal unions for expected outcomes | Depth limit exceeded is a bug; `sendMessage` returns `'not_found' \| 'terminal' \| 'queue_full'` as expected states            |
| Interactive UI (`cli/commands/ui.ts`)                 | Result object (`InteractiveUiResult`) with `status` + exit codes                | User cancel and timeout are expected operational outcomes, not errors. IPC failures are exceptional.                           |

## 4. Interactive UI interactions (`assistant ui confirm` / `assistant ui request`)

The `assistant ui` commands present blocking interactive surfaces (confirmations, forms) to the user and wait for a response. Their error model distinguishes three categories:

### Expected outcomes (not errors)

User decisions — including declining — are normal operational results:

| Status                              | Exit code | Meaning                                                                  |
| ----------------------------------- | --------- | ------------------------------------------------------------------------ |
| `submitted` (confirmed)             | 0         | User completed the interaction. Proceed with the gated action.           |
| `submitted` (denied via `actionId`) | 1         | User explicitly chose the deny/secondary action. Abort gracefully.       |
| `cancelled`                         | 1         | User dismissed the surface without choosing an action. Abort gracefully. |
| `timed_out`                         | 1         | No user response within the timeout window. Abort safely.                |

Scripts must handle all three non-confirmation outcomes. A `cancelled` status means the user deliberately chose not to proceed — log it as a normal flow, not an error. A `timed_out` status means the user was unresponsive — abort without side effects.

### Operational errors (exceptional)

These indicate infrastructure or configuration problems, not user decisions:

- **IPC unavailable**: The daemon is not running or the socket is unreachable. The CLI exits non-zero with an error message.
- **No conversation context**: Neither `--conversation-id` nor `__SKILL_CONTEXT_JSON` provided a valid conversation ID.
- **Invalid payload**: Malformed JSON in `--payload` or stdin.
- **No interactive surface**: The active channel does not support interactive UI (headless/API mode).

In `--json` mode, operational errors return `{ "ok": false, "error": "<message>" }`. Without `--json`, they print to stderr and exit non-zero.

### Branching pattern

```typescript
const proc = Bun.spawn(
  [
    "assistant",
    "ui",
    "confirm",
    "--title",
    "Send email",
    "--message",
    `Send to ${recipient}?`,
    "--confirm-label",
    "Send",
    "--deny-label",
    "Cancel",
    "--json",
  ],
  { stdout: "pipe" },
);

const raw = await new Response(proc.stdout).text();
const result = JSON.parse(raw);

if (!result.ok) {
  // Operational error — IPC failure, no conversation, etc.
  throw new Error(`UI request failed: ${result.error}`);
}

switch (result.status) {
  case "submitted":
    if (result.confirmed) {
      // User confirmed — proceed with the action
      await sendEmail(draftId);
    } else {
      // User denied — abort gracefully
      return { sent: false, reason: "User declined" };
    }
    break;
  case "cancelled":
    // User dismissed — abort gracefully
    return { sent: false, reason: "User cancelled" };
  case "timed_out":
    // No response — abort safely
    return { sent: false, reason: "Timed out" };
}
```

The key distinction: **cancellation and denial are user decisions** (handle gracefully, no error logging). **IPC failures and missing context are bugs or environment issues** (throw or log as errors).
