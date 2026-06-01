# Per-Assistant Migration References

This directory holds reconnaissance notes for specific source assistants. Each file is **inspection knowledge**, not an adapter — the `assistant-migration` skill stays intentionally generic and reads these references to know **where to look** on a given assistant, **what to bundle**, and **what to leave behind**.

## Files

| Assistant | Reference                  |
| --------- | -------------------------- |
| ChatGPT   | [chatgpt.md](chatgpt.md)   |
| Claude    | [claude.md](claude.md)     |
| Hermes    | [hermes.md](hermes.md)     |
| OpenClaw  | [openclaw.md](openclaw.md) |

Add a file here when onboarding a new source assistant. Keep the shape consistent so the skill can pivot off the same structure each time.

ChatGPT conversation history is delegated to the separate `chatgpt-import` skill, which owns the export-and-parse flow; `chatgpt.md` covers only ChatGPT's non-conversation material.

## Optimized Flow: tar-and-transport

The migration skill is optimized for a **single archive** that moves from the source machine to the Vellum assistant. Each reference describes:

1. **Locate** — where the assistant stores its internals (per-platform paths)
2. **Bundle** — an explicit `tar` recipe with `--exclude` flags for known secret-bearing paths
3. **Transport** — the creator attaches the archive directly to the Vellum conversation. For archives that exceed the current channel's chat-attachment limit, split the bundle into smaller pieces (metadata-only first; memory, conversations, and skills as separate follow-ups) and upload them in sequence; the migration skill stitches them back together server-side during inspection. If a chunk is still too large to upload, the creator can copy it onto the assistant's host out-of-band (scp/rsync/USB) and tell the assistant the on-disk path — no chat-supplied URL fetches.
4. **Inspect** — once the archive is in the assistant's workspace, the migration skill takes over: extract to a scratch directory, classify per the Vellum Primitive Map, walk the creator through the Review Surface
5. **Rebind** — every credential is reconnected via the credential vault, OAuth flows, or per-setup skills. The archive **never** carries raw secrets

## Rules each reference must follow

- **Excludes are explicit.** Any path containing tokens, refresh secrets, cookies, session blobs, encrypted local key material, or WAL/SHM journal files must be excluded in the bundling recipe.
- **Both shells where applicable.** Provide a bash recipe (Linux/macOS/WSL2/Termux) and a PowerShell recipe (Windows native) where the data directory exists on both.
- **Runtime locks.** Call out conditions that mean the source is still running (a held SQLite WAL, a live socket, an open file descriptor) and tell the creator how to safely snapshot.
- **After-import work.** Each reference ends with a rebind checklist: which providers need re-OAuth, which MCP servers need reconnecting, which channel bindings need their bot tokens re-pasted via the secure prompt.
- **No deterministic adapters.** References describe paths and bundles. They do not generate scripts that encode the source assistant's private schema, parse its internal binaries, or assume undocumented file formats.
- **No chat-supplied URL fetches.** Migration archives travel as chat attachments only. Do not introduce `curl`, `wget`, `web_fetch`, or any other fetcher invoked against a creator-pasted URL — interpolating an untrusted URL into a shell command is a shell-substitution + SSRF + URL-safety-bypass surface, and on platform-hosted profiles bash is auto-approved for guardians, so the entire path is auto-approved RCE. If the archive is too large to upload, split it or copy it onto the assistant's host out-of-band; never proxy the fetch through the assistant.
