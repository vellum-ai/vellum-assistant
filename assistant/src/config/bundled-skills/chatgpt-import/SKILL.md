---
name: "ChatGPT Import"
description: "Import conversation history from ChatGPT into Vellum"
metadata: {"vellum": {"emoji": "📥"}}
user-invocable: true
---

Import ChatGPT conversation history into Vellum so users can keep their conversation context and memory when switching from ChatGPT.

## How to guide the user

When a user wants to import their ChatGPT conversations, walk them through this process:

1. **Ask for the export file.** Tell the user to go to ChatGPT → Settings → Data controls → Export data. ChatGPT will email them a ZIP file.
2. **Get the file path.** Ask the user for the path to their downloaded `conversations.json` file or the ZIP file.
3. **Preview first.** Always run `chatgpt_import` with `dry_run: true` first to show the user what will be imported (conversation count, message count, titles).
4. **Confirm and import.** After the user confirms, run `chatgpt_import` with `dry_run: false` to perform the actual import.
5. **Report results.** Tell the user how many conversations and messages were imported, and mention any skipped duplicates.

## Notes

- The tool accepts either a `conversations.json` file or the full ZIP export from ChatGPT.
- Conversations are deduplicated — re-importing the same file will skip already-imported conversations.
- Only user and assistant messages are imported (system prompts and tool calls are filtered out).
- Original timestamps from ChatGPT are preserved.
- Imported conversations are automatically indexed for memory search.
