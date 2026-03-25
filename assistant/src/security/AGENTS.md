# Security — Agent Instructions

## Integration API Key Patterns

When adding a new third-party integration, check whether the service uses a recognizable API key prefix (e.g., `lin_api_`, `sk-ant-`, `ghp_`). If it does, add a corresponding entry to `PREFIX_PATTERNS` in `secret-patterns.ts`. This is the single source of truth for prefix-based secret detection — ingress blocking, tool output scanning, and log redaction all consume this list.

OAuth-only services with opaque access tokens (no fixed prefix) do not need a pattern.
