# Claude → Vellum

Claude (Anthropic) is a hosted assistant, handled **separately from ChatGPT**. There is no `chatgpt-import`-equivalent deterministic importer for Claude, and no single guaranteed export shape. Claude migrations are more **summary/export-driven**: route by whatever the creator actually has.

## Locate

Three sources, in order of preference:

| Source                                                           | What it contains                                                            | How to obtain it                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Official Claude data export (Settings → Privacy)                 | Account data including conversations, depending on plan                     | Anthropic emails a download link; arrives as a downloadable archive              |
| Individual conversation exports / copies                         | One or more specific conversations the creator cares about                  | Creator copies conversation text, or uses any per-conversation export available  |
| Claude-produced self-summaries (fallback, often the only option) | Identity, preferences, relationships, active projects, durable instructions | Ask Claude to produce portable summaries per SKILL.md's "Memory Import Guidance" |

Prefer an official export when the creator has one. When there is no export, fall back to the interview/summary flow: ask Claude for high-signal, reviewable summaries (identity, preferences, relationships, active projects, durable instructions, meaningful recent history) and bring them in as memory candidates.

Nothing lives on the creator's local machine to tar; there is no per-platform data-directory table.

## Bundle

No `tar` recipe applies — like ChatGPT, Claude produces any archive for you, and the common case is pasted text rather than a file. The "bundle" is whichever of the three sources the creator has:

- Official export archive: treat as opaque-but-trusted input; do not repackage or assume an internal schema.
- Conversation copies / self-summaries: plain text or a small text file.

No secret-bearing local files are in scope, so there is nothing to `--exclude` — but never paste account credentials or integration tokens (see Rebind).

## Transport

- **Export archive**: the creator attaches it directly to the conversation, or tells the assistant the on-disk path where they downloaded it. **Never** fetch the Anthropic-emailed download link by pasting the URL into chat and running `curl`/`wget` against it — a chat-supplied URL interpolated into a shell command is a shell-substitution + SSRF + URL-safety-bypass surface. See [README.md](README.md).
- **Conversation copies / summaries**: delivered as chat text. No transport command needed.

## Inspect

- There is **no deterministic Claude importer**. Conversation and memory material is brought in as **reviewed memory candidates**, not bulk-dumped. Summarize useful history into memory candidates and present them for creator review rather than saving wholesale.
- If/when a **structured Claude export** is available, classify it per the Internals Salvage Guidance (high / medium / low confidence) rather than assuming a schema. Clearly-labeled markdown/JSON is high-confidence; opaque blobs are low-confidence and should be reviewed or rebuilt.
- Map non-conversation material per the Vellum Primitive Map in SKILL.md: identity/preferences → Identity and Personality; durable instructions → Memory; described tools/MCP → Skills and MCP setup tasks; relationships → Contacts.

## Rebind — secrets checklist

Claude / Anthropic credentials and connected secrets are **never** imported:

- **Anthropic / Claude account login**: not migrated. The creator signs into Vellum independently.
- **Connected MCP servers and integrations**: reconnect through Vellum's MCP setup and OAuth connect flows. Any tokens present in an export or pasted config are ignored.
- **API keys**: rebind via `assistant credentials prompt`, never via chat text.

When in doubt, pause and ask before sending any production message on a newly reconnected integration.
