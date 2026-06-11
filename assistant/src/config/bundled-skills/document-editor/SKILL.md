---
name: document-editor
description: Use whenever the user wants to write or draft an article, blog post, essay, report, or any long-form content. Creates the content in a rich text editor instead of dumping it in chat, so it can be streamed, reviewed, edited, and exported.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "✍️"
  vellum:
    display-name: "Document Writer"
    category: "content"
    activation-hints:
      - "User asks to write, draft, or compose an article, blog post, essay, report, story, or any long-form content — always create it in the document editor, not as a chat reply"
      - "User wants written content they will iterate on, review, or export — use the editor instead of inline markdown"
      - "A file attachment contains a draft or document the user wants to revise — open it in the editor"
    avoid-when:
      - "The user wants an interactive app, dashboard, calculator, game, or anything with state or data — use app-builder instead"
      - "A one or two sentence answer is enough — just reply in chat"
---

Write and edit long-form documents using the built-in rich text editor. Documents open in workspace mode with chat docked to the side. When a request is about writing prose (an article, blog post, report, essay, story, or similar), create it here rather than writing it into the chat response.

## Tools

- **document_create** - Opens a new document editor with an optional title and initial Markdown content. Returns a `surface_id` for subsequent updates. This is the entry point for any new piece of writing.
- **document_update** - Updates content in an open document editor by `surface_id`. Supports `replace` (overwrite) and `append` (add to end) modes.
- **document_read** - Reads the current content of a document by `surface_id` when it belongs to the current conversation, or when the current actor is the guardian/local user. Use to verify content before editing.
- **document_find** - Searches a document for text or regex patterns. Returns matching lines with line numbers, match positions, and matched text.
- **document_replace_text** - Targeted find-and-replace within a document. Supports literal and regex patterns (with backreferences). Optionally limit the number of replacements.
- **document_list** - Lists documents. Without `query`, lists the current conversation's documents. With `query`, searches by title; guardian/local users can search across conversations, while other actors are scoped to the current conversation.
- **document_open** - Opens an existing document in the editor panel by `surface_id`. Use this when a document exists but isn't visible in the editor — for example after the user switches devices, refreshes the page, or when the editor panel was closed. Fetches the document from storage and sends it to the client.
- **document_delete** - Deletes a document by `surface_id`. Use to clean up unwanted documents.

## Creating a new document

This is the default path when the user asks you to write something.

1. **Create the document**: Call `document_create` with a title (inferred from the request). Call the tool immediately, not after conversational preamble. Capture the `surface_id` from the response — every subsequent `document_update` call must reference it.
2. **Write content in Markdown**: Use proper structure (`#` for titles, `##` for sections), **bold**, _italic_, code blocks, tables, lists, blockquotes as appropriate.
3. **CRITICAL - Stream content in chunks**: Call `document_update` MULTIPLE times, not just once. Break content into logical chunks (paragraphs, sections, or every 200-300 words). Call `document_update` with `mode: "append"` for EACH chunk separately. The user experiences real-time content appearing as you write.

### Recovering from a failed update

If a `document_update` call fails with an `Invalid input` error (for example because `surface_id` was missing), do NOT call `document_create` again. The `surface_id` you need is in the tool result of the most recent `document_create` call in this turn. Retry `document_update` with that `surface_id` and the same content. Creating a second document with the same title produces a duplicate for the user.

## Editing an existing document

When the user requests changes to a document:

1. Find the `surface_id` from the `<active_documents>` context block.
2. Use `document_update` with the existing `surface_id` — do NOT call `document_create` again.
3. **Choose the right editing tool:**
   - `document_update` with `mode: "append"` — adding new content to the end.
   - `document_update` with `mode: "replace"` — ONLY for full rewrites where the majority of the document is changing.
   - `document_find` + `document_replace_text` — **for everything else**. Fixing typos, renaming terms, swapping sections, reordering content, adjusting formatting, or any edit that touches only part of the document. This is the default choice for edits. It avoids rewriting the entire document and eliminates the risk of accidentally dropping content.
4. **Do NOT use `document_update` with `mode: "replace"` for targeted edits.** Rewriting the entire document to change a few words or rearrange sections is wasteful and error-prone.

## Retrieving existing documents

When the user asks to see, open, or pull up a document:

1. Check the `<active_documents>` block in your context — it lists all documents in this conversation with their `surface_id` and title.
2. If the document is NOT in `<active_documents>`, call `document_list` with a `query` matching the document title. For guardian/local users, this searches across previous conversations and sessions.
3. Once you have the `surface_id`, call `document_open` to open the editor panel. This surfaces the editor on the client and returns document metadata (`surface_id`, `title`, `word_count`) — not the full content. If you need the actual document text, follow up with `document_read`.

**Never** search the filesystem, conversation history, or archives to find a document. Always use `document_list` with a `query`.

**If the user says they can't see a document you know exists** (e.g. after switching from macOS to web, or after a page refresh), call `document_open` with the `surface_id` to re-surface the editor panel on their current client.

## Find & Replace

Use `document_find` and `document_replace_text` for surgical edits that target specific text patterns without rewriting the entire document.

### document_find

Search a document for literal text or regex patterns. Parameters:

- `surface_id` (required) — the document to search
- `query` (required) — the search string or regex pattern
- `regex` (optional, default `false`) — treat `query` as a regular expression
- `case_sensitive` (optional, default `false`) — match case exactly

Returns a list of matches with line numbers, line content, match positions, and matched text. Use this to preview what will be affected before making replacements.

### document_replace_text

Targeted find-and-replace within a document. Parameters:

- `surface_id` (required) — the document to modify
- `find` (required) — the search string or regex pattern
- `replace` (required) — the replacement string (supports `$1`, `$2` backreferences when `regex` is `true`)
- `regex` (optional, default `false`) — treat `find` as a regular expression
- `case_sensitive` (optional, default `false`) — match case exactly
- `max_replacements` (optional) — limit the number of replacements made

Returns the number of replacements made and whether the content changed.

### Workflow

1. Call `document_find` to preview matches and confirm the pattern is correct.
2. Call `document_replace_text` to apply the changes.

**Examples:**

- **Fix a recurring typo**: Find `"recieve"`, replace with `"receive"`.
- **Rename a term throughout**: Find `"widget"` (case-insensitive), replace with `"component"`.
- **Reformat dates with regex**: Find `(\d{2})/(\d{2})/(\d{4})` with `regex: true`, replace with `$3-$1-$2` to convert `MM/DD/YYYY` to `YYYY-MM-DD`.
- **Swap or reorder sections**: Use `document_read` to get the content, identify the sections to swap, then call `document_replace_text` to replace the first section with the second and vice versa. For complex rearrangements, use multiple `document_replace_text` calls with `max_replacements: 1`.

## Comments

Users can leave inline comments on documents. Open comments are surfaced in a `<document_comments>` context block so you can see pending feedback.

- **comment_list** — Lists open comments on a document by `surface_id`. Use this to check for feedback before or after editing, especially when the user asks you to address comments.
- **comment_resolve** — Marks a comment as resolved by `comment_id`. Use this after you have addressed the feedback in the document content. Always edit the document first, then resolve the comment.
- **comment_reply** — Posts a reply to an existing comment by `comment_id`. Use this to ask clarifying questions or explain why you made (or declined) a change before resolving.

### Addressing comments workflow

1. Read the `<document_comments>` block or call `comment_list` to see open comments.
2. For each comment, edit the document to address the feedback.
3. Call `comment_resolve` on comments you have addressed.
4. If a comment is ambiguous, call `comment_reply` to ask for clarification instead of guessing.

## Anti-Patterns

- **Don't use `app_create` for blog posts, articles, or written content.** Use `document_create` — apps are for interactive content with state/data.
- **Don't write the article into the chat response.** Long-form prose goes in the document editor via `document_create`, not in chat and not into a `.md` file in the workspace. Acknowledge what you're doing and stream to the editor.
- **Don't wait to generate everything before sending.** Stream content in chunks via `document_update` with `mode: "append"` so users see progress in real time.

## Usage Notes

- The `mode` parameter on `document_update` defaults to `append`.
- Documents are automatically saved and accessible via the Generated panel.
- Users can manually edit documents at any time.
- Write in clear, engaging prose. Use active voice, vary sentence structure, and break content into logical sections with descriptive headings.
