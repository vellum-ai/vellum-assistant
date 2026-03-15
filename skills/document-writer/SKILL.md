---
name: document-writer
description: Create and edit long-form documents like blog posts, articles, essays, and reports using the built-in rich text editor
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📝"
  vellum:
    display-name: "Document Writer"
---

You are helping your user write long-form content (blog posts, articles, essays, reports, documentation) using the built-in document editor. This skill should be used whenever the user asks to write, draft, or create any document-like content.

## When to Use This Skill

**ALWAYS use this skill when the user asks for:**
- Blog posts
- Articles
- Essays
- Reports
- Guides or tutorials
- Documentation
- Any long-form written content (500+ words)

**DO NOT use this skill for:**
- Short responses or explanations (< 500 words)
- Code snippets or technical implementations
- Interactive apps or dashboards (use `app_create` instead)
- Quick summaries

## Workflow

### Step 1: Create the Document

Use `document_create` to open the built-in rich text editor:

```json
{
  "title": "The title of the document (inferred from user's request)",
  "initial_content": "Optional starting content in Markdown format"
}
```

**Important:** The editor opens in the Documents tab of the Directory panel, with chat docked to the side. The user can see both the editor and chat simultaneously.

### Step 2: Generate Content

Write the content in **Markdown format**. Use proper structure:

- `#` for main title
- `##` for section headings
- `###` for subsections
- `**bold**` and `*italic*` for emphasis
- ` ```language ` for code blocks
- `[text](url)` for links
- `- ` or `1. ` for lists
- `> ` for blockquotes
- Tables, images, and other Markdown features as appropriate

**Quality standards:**
- Write in clear, engaging prose appropriate for the content type
- Use active voice and vary sentence structure
- Break content into logical sections with descriptive headings
- Include transitions between sections
- For technical content: use code blocks with syntax highlighting
- For data-heavy content: use Markdown tables

### Step 3: Stream Content to Editor

Use `document_update` to send content to the editor as you generate it:

```json
{
  "surface_id": "doc-xyz",
  "content": "# Main Title\n\nYour content here...",
  "mode": "append"
}
```

**Streaming strategy:**
- Generate content in logical chunks (paragraphs or sections)
- Use `mode: "append"` to stream chunks as you write
- The content appears in real-time in the editor
- Don't wait to generate everything before sending - stream it!

### Step 4: Handle User Edits and Requests

The user can request changes via the docked chat while viewing the document:

**Common requests:**
- "Make the intro shorter"
- "Add a section about X"
- "Change the tone to be more formal"
- "Fix the grammar in paragraph 3"

**How to respond:**
- Acknowledge the request
- Generate the updated content
- Use `document_update` with:
  - `mode: "replace"` for complete rewrites
  - `mode: "append"` for additions at the end
  - For edits in the middle: use `mode: "replace"` with the full updated document

### Step 5: Finalize

Once the user is satisfied:
- Confirm the document is complete
- Remind them that it's automatically saved in the Generated panel
- Let them know they can continue editing manually or ask for more changes

## Examples

### Example 1: Blog Post Request

**User:** "Write a blog post about the future of AI"

**Your response:**
```
I'll create a document for your blog post about the future of AI.
```

Then:
1. Call `document_create` with `title: "The Future of AI"`
2. Generate content in chunks, calling `document_update` repeatedly:
   - First chunk: `# The Future of AI\n\nArtificial intelligence is...`
   - Second chunk: `## Current State\n\nToday, AI systems...`
   - Third chunk: `## Emerging Trends\n\n1. **Multimodal AI**...`
   - Continue until complete

### Example 2: Edit Request

**User (after initial creation):** "Add a section about ethical considerations"

**Your response:**
```
I'll add a section on AI ethics.
```

Then:
1. Call `document_update` with `mode: "append"` and content:
   ```markdown
   ## Ethical Considerations

   As AI systems become more powerful, we must address...
   ```

### Example 3: Full Rewrite

**User:** "Rewrite this in a more casual tone"

**Your response:**
```
I'll rewrite the article in a more casual, conversational tone.
```

Then:
1. Call `document_update` with `mode: "replace"` and the complete rewritten content

## Important Notes

- **Documents are automatically saved** and accessible via the Generated panel
- The user can **manually edit documents** at any time - your role is to assist with generation and refinement
- The editor supports **drag-and-drop images**, which are converted to base64 inline
- **Word count is tracked** automatically and displayed to the user
- **Toast UI Editor** is used, which provides both Markdown and WYSIWYG editing modes
- Always **acknowledge the document creation** before calling `document_create`

## Error Handling

- If `document_create` fails, the user may not have the client connected. Ask them to check their connection.
- If the user asks to edit a specific part but you don't have the full document context, ask them to clarify which section or provide more context.
- If you're unsure about the content direction, ask clarifying questions before generating.

## Anti-Patterns (DO NOT DO THIS)

❌ **Don't use `app_create` for blog posts or articles**
- Blog posts should use `document_create`, not `app_create`
- Apps are for interactive content with state/data

❌ **Don't write everything at once without streaming**
- Use `document_update` with `mode: "append"` to stream chunks
- Users want to see content appear in real-time

❌ **Don't ask for explicit approval before creating the document**
- If the user asks for a blog post, create it immediately
- They can always request changes after

❌ **Don't output the full content in chat**
- The content goes in the document editor, not in the chat response
- Just acknowledge what you're doing and stream to the editor

## Success Criteria

✅ Document editor opens in the Documents tab
✅ Content appears in real-time as you generate it
✅ User can see both the editor and chat side-by-side
✅ Content is well-structured with proper Markdown formatting
✅ User can request edits via chat and you respond appropriately
✅ Final document is saved and accessible in Generated panel
