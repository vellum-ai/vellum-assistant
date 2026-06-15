# ChatGPT → Vellum

ChatGPT is a hosted assistant. There is **no local workspace or data directory** to tar — the portable source of truth is the official account export, an emailed ZIP. This reference covers locating that export and mapping the **non-conversation** material. Conversation history itself is handled by the separate `chatgpt-import` skill (see Inspect).

## Locate

ChatGPT stores everything server-side, so the inventory comes from two places:

| Source                                                           | What it contains                                                          | How to obtain it                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Official account export (Settings → Data controls → Export data) | Conversations, custom instructions, saved memories, account metadata      | ChatGPT emails a download link; the ZIP arrives as an attachment or on-disk file |
| User-pasted summaries (fallback)                                 | Custom instructions text, "what ChatGPT should know about you", GPT setup | Creator copies from Settings → Personalization / their GPTs, or asks ChatGPT     |

There is no per-platform path table — nothing lives on the creator's machine except the downloaded export ZIP wherever they saved it. If the creator cannot or does not want to run the official export, fall back to the interview/summary flow in SKILL.md's "Memory Import Guidance."

## Bundle

No `tar` recipe applies — ChatGPT produces the archive for you. The export ZIP **is** the bundle. Do not attempt to reconstruct or repackage ChatGPT internals; treat the official ZIP as opaque-but-trusted input and let `chatgpt-import` parse it.

For non-conversation material that is not in the export (or that the creator prefers to hand over directly), the "bundle" is plain pasted text or a small text file: custom instructions, saved memories, and GPT descriptions. No secret-bearing files are involved, so there is nothing to `--exclude` — but never paste account credentials or connected-app tokens (see Rebind).

## Transport

- **Export ZIP**: the creator attaches it directly to the conversation as a chat attachment, or tells the assistant an on-disk path where they downloaded it. **Never** fetch the ChatGPT-emailed download link by pasting the URL into chat and running `curl`/`wget` against it — a chat-supplied URL interpolated into a shell command is a shell-substitution + SSRF + URL-safety-bypass surface. The creator downloads the ZIP themselves, then attaches the file. See [README.md](README.md).
- **Pasted summaries / instructions**: delivered as chat text. No transport command needed.

## Inspect

- **Conversation history → delegate to `chatgpt-import`.** Once the creator has the export ZIP, invoke the `chatgpt-import` skill. That skill owns the export-and-parse flow and the `assistant conversations import` step. Do **not** duplicate its parse logic or re-document its commands here — cross-reference it by name.
- **Non-conversation material → normal inventory/review flow.** The official export ZIP also contains custom instructions and saved memories that `chatgpt-import` does not consume — unzip the export and read those files directly into the inventory rather than relying on the creator to re-paste them. Map per the Vellum Primitive Map in SKILL.md:
  - Custom instructions / "what ChatGPT should know about you" / "how ChatGPT should respond" → Identity, Personality, durable Memory instructions.
  - Saved memories → Memory candidates (review before saving; ChatGPT memories can be inferred or stale).
  - GPT configs (names, descriptions, instructions, knowledge files) → Skills, recreated as portable Vellum skills. Connected actions become MCP / integration setup tasks, not direct imports.

Classify everything that is not a clean structured export per the Internals Salvage Guidance (high/medium/low confidence) rather than assuming a schema.

## Rebind — secrets checklist

ChatGPT account credentials and connected-app tokens are **never** imported:

- **ChatGPT / OpenAI account login**: not migrated. The creator signs into Vellum independently.
- **Connected apps and custom-GPT actions** (Google Drive, GitHub, third-party action OAuth): reconnect through Vellum's vault / OAuth connect flows. Tokens from the export or from any pasted config are ignored.
- **API keys** referenced in GPT actions or instructions: rebind via `assistant credentials prompt`, never via chat text.

When in doubt, pause and ask before sending any production message on a newly reconnected integration.
