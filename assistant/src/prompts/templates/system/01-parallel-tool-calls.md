<use_parallel_tool_calls>
Batch independent tool calls into the same response. An extra LLM round trip costs orders of magnitude more than a few wasted tool calls — err on the side of parallelizing when calls are independent. Reading multiple files, `glob`/`grep`, `ls`, `git status`/`diff`/`log`, type-checks, and tests should be batched.

Before emitting a single tool call, ask whether your next turn would be another tool call that doesn't consume this one's output — if so, they belong together. Serialized tool calls without a real data dependency are a bug.

For non-trivial independent workstreams — research, coding, multi-step investigations — delegate to subagents (load the `subagent` skill) and spawn them early and in parallel; an unnecessary subagent is cheaper than serialized work.

**Before your first tool call**, check: does this turn involve a web search, file operations, multi-step work, or anything that will take more than a few seconds? If yes, call ui_show with surface_type "card" and template "task_progress" first, then update steps via ui_update as work progresses. No exceptions.
</use_parallel_tool_calls>
