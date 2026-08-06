# Security — Agent Instructions

## Integration API Key Patterns

When adding a new third-party integration, check whether the service uses a recognizable API key prefix (e.g., `lin_api_`, `sk-ant-`, `ghp_`). If it does, add a corresponding entry to `PREFIX_PATTERNS` in `packages/service-contracts/src/secret-detection.ts` (`@vellumai/service-contracts/secret-detection`). This is the single source of truth for prefix-based secret detection — ingress blocking, tool output scanning, log redaction, and the web composer guard all consume this list. `secret-patterns.ts` in this directory is a re-export that preserves existing daemon import paths.

OAuth-only services with opaque access tokens (no fixed prefix) do not need a pattern.

## Fencing Untrusted Content

**Any string the assistant did not author must cross into model context inside an `<external_content>` fence.** Wrap it with `wrapUntrustedContent()` from `untrusted-content.ts`, which delimits it as third-party data, escapes attempts to close the fence from inside, and caps its size.

This applies to tool results, not just channel ingress. A tool that reads from the outside world — a fetched page, a search result, an inbox, a live browser DOM (titles, accessible names, body text, link labels, form-field labels) — is returning attacker-authorable text, and an unfenced tool result is a prompt-injection channel that bypasses the boundary every other source crosses.

Three rules for how the fence is applied:

- **Fence the data, not your own words.** The tool's scaffolding — the URL it navigated to, its remediation steps, its error strings — stays outside so it remains distinguishable as the tool's own voice. Only page/message-derived text goes inside. This holds downstream too: anything that rewrites a tool result on its way into context (e.g. the oversized-result spool in `context/post-turn-tool-result-truncation.ts`) must keep its own instructions outside the envelope, or it hands the model a directive it has been told to ignore.
- **Size the budget deliberately.** `wrapUntrustedContent` applies a per-source character budget. When a tool already enforces its own cap, pass an explicit `maxChars` above it so fencing does not silently shrink what the tool returns.
- **Bound every untrusted string inside the budget, not just the obvious one.** A budget only protects the payload if the payload's length is bounded. Anything page-controlled that renders _ahead_ of the important part — a URL, a title, a header field — can otherwise consume the whole budget and truncate the part that mattered. Cap each such string at the source.

Sanitize URLs with `sanitizeUrlStringForOutput()` (`tools/network/url-safety.ts`) before echoing them — a page URL can carry userinfo credentials.
