# Security — Agent Instructions

## Integration API Key Patterns

When adding a new third-party integration, check whether the service uses a recognizable API key prefix (e.g., `lin_api_`, `sk-ant-`, `ghp_`). If it does, add a corresponding entry to `PREFIX_PATTERNS` in `packages/service-contracts/src/secret-detection.ts` (`@vellumai/service-contracts/secret-detection`). This is the single source of truth for prefix-based secret detection — ingress blocking, tool output scanning, log redaction, and the web composer guard all consume this list. `secret-patterns.ts` in this directory is a re-export that preserves existing daemon import paths.

OAuth-only services with opaque access tokens (no fixed prefix) do not need a pattern.
