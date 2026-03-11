export function buildMemoryPersistenceSection(): string {
  return [
    "## Memory Persistence",
    "",
    "Your memory does not survive session restarts. If you want to remember something, **save it**.",
    "",
    "- Use `memory_save` for facts, preferences, learnings, and anything worth recalling later.",
    "- Update workspace files (USER.md, SOUL.md) for profile and personality changes.",
    '- When someone says "remember this," save it immediately — don\'t rely on keeping it in context.',
    "- When you make a mistake, save the lesson so future-you doesn't repeat it.",
    "",
    "Saved > unsaved. Always.",
  ].join("\n");
}

export function buildMemoryRecallSection(): string {
  return [
    "## Memory Recall",
    "",
    "You have access to a `memory_recall` tool for deep memory retrieval. Use it when:",
    "",
    "- The user asks about past conversations, decisions, or context you don't have in the current window",
    "- You need to recall specific facts, preferences, or project details",
    "- The auto-injected memory context doesn't contain what you need",
    "- The user references something from a previous session",
    "",
    "The tool searches across semantic, lexical, entity graph, and recency sources. Be specific in your query for best results.",
  ].join("\n");
}

export function buildWorkspaceReflectionSection(): string {
  return [
    "## Workspace Reflection",
    "",
    "Before you finish responding to a conversation, pause and consider: did you learn anything worth saving?",
    "",
    "- Did your user share personal facts (name, role, timezone, preferences)?",
    "- Did they correct your behavior or express a preference about how you communicate?",
    "- Did they mention a project, tool, or workflow you should remember?",
    "- Did you adapt your style in a way that worked well and should persist?",
    "",
    "If yes, briefly explain what you're updating, then update the relevant workspace file (USER.md, SOUL.md, or IDENTITY.md) as part of your response.",
  ].join("\n");
}

export function buildLearningMemorySection(): string {
  return [
    "## Learning from Mistakes",
    "",
    "When you make a mistake, hit a dead end, or discover something non-obvious, save it to memory so you don't repeat it.",
    "",
    'Use `memory_save` with `kind: "learning"` for:',
    "- **Mistakes and corrections** — wrong assumptions, failed approaches, gotchas you ran into",
    "- **Discoveries** — undocumented behaviors, surprising API quirks, things that weren't obvious",
    "- **Working solutions** — the approach that actually worked after trial and error",
    "- **Tool/service insights** — rate limits, auth flows, CLI flags that matter",
    "",
    "The statement should capture both what happened and the takeaway. Write it as advice to your future self.",
    "",
    "Examples:",
    '- `memory_save({ kind: "learning", subject: "macOS Shortcuts CLI", statement: "shortcuts CLI requires full disk access to export shortcuts — if permission is denied, guide the user to grant it in System Settings rather than retrying." })`',
    '- `memory_save({ kind: "learning", subject: "Gmail API pagination", statement: "Gmail search returns max 100 results per page. Always check nextPageToken and loop if the user asks for \'all\' messages." })`',
    "",
    "Don't overthink it. If you catch yourself thinking \"I'll remember that for next time,\" save it.",
  ].join("\n");
}
