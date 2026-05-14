---
name: document
description: Write, draft, or compose long-form text (blog posts, articles, essays, reports, guides)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📄"
  vellum:
    display-name: "Document"
    activation-hints:
      - "User asks to write, draft, or collaborate on long-form content — use the document editor for a better editing experience"
      - "When content will be iterated on, reviewed, or exported, prefer the document editor over inline markdown"
      - "When a file attachment contains a draft or document the user wants to iterate on, open it in the editor"
---

Create and edit long-form documents using the built-in rich text editor. Documents open in workspace mode with chat docked to the side.

## Tools

- **document_create** - Opens a new document editor with an optional title and initial Markdown content. Returns a `surface_id` for subsequent updates.
- **document_update** - Updates content in an open document editor by `surface_id`. Supports `replace` (overwrite) and `append` (add to end) modes.
- **document_read** - Reads the current content of a document by `surface_id`. Use to verify content before editing.
- **document_list** - Lists documents. Without `query`, lists the current conversation's documents. With `query`, searches all documents by title across all conversations.
- **document_delete** - Deletes a document by `surface_id`. Use to clean up unwanted documents.

## Retrieving existing documents

When the user asks to see, open, or pull up a document:

1. Check the `<active_documents>` block in your context — it lists all documents in this conversation with their `surface_id` and title. If the document is there, call `document_read` with its `surface_id`. Done in one call.
2. If the document is NOT in `<active_documents>`, call `document_list` with a `query` matching the document title. This searches across all conversations and previous sessions.
3. Once you have the `surface_id`, call `document_read` to retrieve the content.

**Never** search the filesystem, conversation history, or archives to find a document. Always use `document_list` with a `query`.

## Creating a new document

1. **Create the document**: Call `document_create` with a title (inferred from the request). Call the tool immediately, not after conversational preamble.
2. **Write content in Markdown**: Use proper structure (`#` for titles, `##` for sections), **bold**, *italic*, code blocks, tables, lists, blockquotes as appropriate.
3. **CRITICAL - Stream content in chunks**: Call `document_update` MULTIPLE times, not just once. Break content into logical chunks (paragraphs, sections, or every 200-300 words). Call `document_update` with `mode: "append"` for EACH chunk separately. The user experiences real-time content appearing as you write.

## Editing an existing document

When the user requests changes to a document:
1. Find the `surface_id` from the `<active_documents>` context block.
2. Use `document_update` with the existing `surface_id` — do NOT call `document_create` again.
3. Use `mode: "replace"` for full rewrites or `mode: "append"` for additions.

## Usage Notes

- The `mode` parameter on `document_update` defaults to `append`.
- Documents are automatically saved and accessible via the Generated panel.
- Users can manually edit documents at any time.
- Write in clear, engaging prose. Use active voice, vary sentence structure, and break content into logical sections with descriptive headings.
