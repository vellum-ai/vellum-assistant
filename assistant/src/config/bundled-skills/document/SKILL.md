---
name: "Document"
description: "Document creation and editing for UI surfaces"
metadata: {"vellum": {"emoji": "📄"}}
---

Create and edit long-form documents using the built-in rich text editor. Documents open in workspace mode with chat docked to the side.

## Tools

- **document_create** — Opens a new document editor with an optional title and initial Markdown content. Returns a `surface_id` for subsequent updates.
- **document_update** — Updates content in an open document editor by `surface_id`. Supports `replace` (overwrite) and `append` (add to end) modes.

## Usage Notes

- Use `document_create` when the user asks to write a blog post, article, or any long-form content.
- After creating a document, use `document_update` with the returned `surface_id` to stream or edit content.
- The `mode` parameter on `document_update` defaults to `append`.
