# Per-Species Migration References

This directory holds reconnaissance notes for specific source species. Each file is **inspection knowledge**, not an adapter — the `species-migration` skill stays intentionally generic and reads these references to know **where to look** on a given species, **what to bundle**, and **what to leave behind**.

## Files

| Species  | Reference                  |
| -------- | -------------------------- |
| Hermes   | [hermes.md](hermes.md)     |
| OpenClaw | [openclaw.md](openclaw.md) |

Add a file here when onboarding a new source species. Keep the shape consistent so the skill can pivot off the same structure each time.

## Optimized Flow: tar-and-transport

The migration skill is optimized for a **single archive** that moves from the source machine to the Vellum assistant. Each reference describes:

1. **Locate** — where the species stores its internals (per-platform paths)
2. **Bundle** — an explicit `tar` recipe with `--exclude` flags for known secret-bearing paths
3. **Transport** — two equally supported modes:
   - **Upload**: creator attaches the archive directly to the Vellum conversation
   - **Hosted URL**: creator places the archive at a private short-TTL URL (signed S3, ephemeral file share, Tailscale HTTP, etc.) and shares the URL in chat; the assistant fetches it once with `curl`
4. **Inspect** — once the archive is in the assistant's workspace, the migration skill takes over: extract to a scratch directory, classify per the Vellum Primitive Map, walk the creator through the Review Surface
5. **Rebind** — every credential is reconnected via the credential vault, OAuth flows, or per-setup skills. The archive **never** carries raw secrets

## Rules each reference must follow

- **Excludes are explicit.** Any path containing tokens, refresh secrets, cookies, session blobs, encrypted local key material, or WAL/SHM journal files must be excluded in the bundling recipe.
- **Both shells where applicable.** Provide a bash recipe (Linux/macOS/WSL2/Termux) and a PowerShell recipe (Windows native) where the data directory exists on both.
- **Runtime locks.** Call out conditions that mean the source is still running (a held SQLite WAL, a live socket, an open file descriptor) and tell the creator how to safely snapshot.
- **After-import work.** Each reference ends with a rebind checklist: which providers need re-OAuth, which MCP servers need reconnecting, which channel bindings need their bot tokens re-pasted via the secure prompt.
- **No deterministic adapters.** References describe paths and bundles. They do not generate scripts that encode the source species' private schema, parse its internal binaries, or assume undocumented file formats.
