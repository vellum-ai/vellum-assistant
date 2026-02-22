## Namespace

Derive a short namespace slug from the feature description to avoid conflicts with parallel swarms. Take the first 3-4 meaningful words of the feature description, convert to kebab-case, and truncate to 20 characters max (e.g., "Add WebSocket transport for daemon IPC" -> `ws-daemon-ipc`). This namespace is used for:
- Prefixing milestone labels in TODO.md to distinguish tasks from different blitzes
- Namespacing swarm branch names to avoid worktree collisions
