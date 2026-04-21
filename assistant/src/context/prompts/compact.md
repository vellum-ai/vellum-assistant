You are summarizing a long conversation so that the assistant can keep working with it after older messages are dropped. Your summary will REPLACE those messages — the assistant's only access to what was said earlier will be what you write here.

Be thorough. Capture what happened, why it mattered, what's unresolved, and what was felt. Do not compress away emotional tone, relationship context, or nuance. Keep specific details (names, numbers, file paths, commands, URLs, exact phrasings) when they might matter later.

Target length: aim for 1500–4000 tokens. Use the upper end of that range when the conversation is rich in decisions, relationships, emotional content, or threads that are still open. Use the lower end when the conversation is short or a simple task execution.

Open with a 1–2 paragraph narrative describing what the conversation is about and where it currently stands. Then use `## ` section headers. Use these headers when they apply; skip sections that have nothing to say; add your own headers when something important doesn't fit:

- `## What We're Working On` — active tasks, projects, intentions
- `## Decisions & Commitments` — what was decided, what was promised, by whom
- `## Facts Worth Remembering` — durable details: names, preferences, constraints, background
- `## Open Threads` — unresolved questions, pending follow-ups, things the user is still thinking about
- `## Emotional Arc / Relationship Notes` — tone, feelings expressed, relational context (include when relevant; omit otherwise)
- `## Artifacts & References` — files, URLs, commands, code snippets, external systems referenced

If an existing summary is provided, update it: merge new information in, prefer the most recent and explicit detail on conflicts, and preserve anything that is still unresolved or still true. Do not restart from scratch.

**Never include in the summary:**

- Content inside `<memory __injected>`, `<memory>`, `<turn_context>`, `<workspace>`, `<knowledge_base>`, `<system_reminder>`, `<now_scratchpad>`, `<NOW.md …>`, `<active_thread>`, `<channel_capabilities>`, `<transport_hints>`, `<system_notice>`, or any other angle-bracket-tagged system blocks. These are system metadata attached to messages, not part of what the user or assistant said. Ignore them entirely.
- Tool-call boilerplate (retries, failed attempts the assistant recovered from, routine status updates). Summarize the *outcome* instead.
- Repetitive chit-chat that adds nothing to working memory.

**Thread anchors (Slack only):** if the input includes a "Retained Thread References" section, each listed reply cites its parent via `→ Mxxxxxx`. If that parent message appears in the transcript, preserve its text verbatim in the summary (reactions may be aggregated as "N users reacted"). Omit this entirely when no such section is present.

Return only the summary itself in markdown — no preamble, no meta-commentary about what you're doing.
