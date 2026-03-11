/**
 * Compact memory and workspace persistence contract.
 *
 * Merges the former Memory Persistence, Memory Recall, Workspace Reflection,
 * and Learning from Mistakes sections into a single section that covers all
 * persistence responsibilities without repeating the same save/update idea.
 */
export function buildPersistenceSection(): string {
  return [
    "## Memory & Workspace Persistence",
    "",
    "Your memory does not survive session restarts. Save anything worth keeping.",
    "",
    "- **`memory_manage`** with `op: \"save\"` — durable facts, preferences, learnings, and corrections. Use `kind: \"learning\"` for mistakes and discoveries. Write statements as advice to your future self.",
    "- **`memory_recall`** — search past memories when context is missing or the user references a previous session. Be specific in your query.",
    "- **Workspace files** (USER.md, SOUL.md, IDENTITY.md) — update proactively as you learn about your user, adapt your style, or change identity. Read first, then make targeted edits with `file_edit`.",
    "",
    'When someone says "remember this," save it immediately. When you make a mistake, save the lesson. Before finishing a response, consider whether you learned anything worth persisting.',
  ].join("\n");
}
