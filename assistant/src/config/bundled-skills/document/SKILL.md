---
name: document
description: Write, draft, or compose long-form text (blog posts, articles, essays, reports, guides)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📄"
  vellum:
    display-name: "Document"
---

Create and edit long-form documents using the built-in rich text editor. Documents open in workspace mode with chat docked to the side.

## Tools

- **document_create** — Opens a new document editor with an optional title and initial Markdown content. Returns a `surface_id` for subsequent updates.
- **document_update** — Updates content in an open document editor by `surface_id`. Supports `replace` (overwrite) and `append` (add to end) modes.

## Workflow

1. **Create the document**: Call `document_create` with a title (inferred from the request). Call the tool immediately, not after conversational preamble.
2. **Write content in Markdown**: Use proper structure (`#` for titles, `##` for sections), **bold**, *italic*, code blocks, tables, lists, blockquotes as appropriate.
3. **CRITICAL — Stream content in chunks**: Call `document_update` MULTIPLE times, not just once. Break content into logical chunks (paragraphs, sections, or every 200-300 words). Call `document_update` with `mode: "append"` for EACH chunk separately. The user experiences real-time content appearing as you write.
4. **Respond to edits**: When the user requests changes via the docked chat, use `document_update` with `replace` for full rewrites or `append` for additions.

## Usage Notes

- The `mode` parameter on `document_update` defaults to `append`.
- Documents are automatically saved and accessible via the Generated panel.
- Users can manually edit documents at any time.
- Write in clear, engaging prose. Use active voice, vary sentence structure, and break content into logical sections with descriptive headings.
