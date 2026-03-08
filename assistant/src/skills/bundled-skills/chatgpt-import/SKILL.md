---
name: chatgpt-import
description: Import conversation history from ChatGPT into Vellum
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"📥","vellum":{"display-name":"ChatGPT Import","user-invocable":true}}
---

Import ChatGPT conversation history into Vellum so users can keep their conversation context and memory when switching from ChatGPT.

## How to guide the user

When a user wants to import their ChatGPT conversations:

1. **Tell the user how to export.** They need to go to ChatGPT → Settings → Data controls → Export data. ChatGPT will email them a ZIP file.
2. **Ask the user to upload the ZIP file.** Use whatever file upload tools or skills are available to receive the ZIP.
3. **Run the import.** Once you have the ZIP file path, call `chatgpt_import` with the file path. Report the results — how many conversations and messages were imported, and any skipped duplicates.

## Notes

- Only ZIP files are accepted (the full export archive from ChatGPT).
- Conversations are deduplicated — re-importing the same file will skip already-imported conversations.
- Only user and assistant messages are imported (system prompts and tool calls are filtered out).
- Original timestamps from ChatGPT are preserved.
- Imported conversations are automatically indexed for memory search.
