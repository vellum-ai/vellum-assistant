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
