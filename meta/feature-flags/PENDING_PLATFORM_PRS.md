# Pending Platform PRs for Feature Flags

This file tracks assistant feature flags that have been declared in
`feature-flag-registry.json` but do not yet have a corresponding
Terraform entry in the `vellum-assistant-platform` repo. Per
`CLAUDE.md` (see the Assistant Feature Flags section) and
`meta/feature-flags/AGENTS.md`, a new flag in this registry requires a
companion PR in `vellum-assistant-platform` to provision the flag on the
platform for remote sync.

Remove an entry from this file once its companion platform PR is merged.

## Open entries

| Flag key | Registry declaration date | Owner | Status | Required platform work |
|---|---|---|---|---|
| `meet` | 2026-04-19 | meet owner | Platform PR not yet opened (as of 2026-04-19) | Terraform entry in `../vellum-assistant-platform/terraform/launchdarkly.tf` (or equivalent) with `defaultEnabled: false` and a description pointing at `skills/meet-join/SKILL.md`. |
| `experiment-activation-flow-2026-06-03` (`variant-b` arm) | 2026-06-11 | activation owner | Platform PR not yet opened (as of 2026-06-11) | Flag already exists in LaunchDarkly; add the `variant-b` string variation (preseeded personal-page app) in `vellum-assistant-platform` terraform, and serve the flag to assistant-scope consumers now that the registry scope changed `client` → `both`. |
| `channel-trust-floors` | 2026-06-17 | admission policy owner | Platform PR not yet opened (as of 2026-06-17) | Terraform entry in `../vellum-assistant-platform/terraform/launchdarkly.tf` (or equivalent) with `defaultEnabled: false` provisioning the `channel-trust-floors` assistant flag, which gates the Channel Trust Floors (per-channel admission policy) Privacy settings card. |
| `mcp-add-server` | 2026-06-23 | MCP settings owner | Platform PR not yet opened (as of 2026-06-23) | Terraform entry in `../vellum-assistant-platform/terraform/launchdarkly.tf` (or equivalent) with `defaultEnabled: false` provisioning the `mcp-add-server` assistant flag, which gates the Add Server action on the MCP settings page. |
| `messages-search-backend` | 2026-06-30 | messages search owner | Platform PR deferred until just before flip (Gate B / PR 9) | Terraform entry in `../vellum-assistant-platform/terraform/launchdarkly.tf` (or equivalent) with `defaultEnabled: false` provisioning the `messages-search-backend` assistant-scope boolean flag (off = `fts5` SQLite full-text search, on = `qdrant` sparse lexical index). Must land before the flag is flipped so managed assistants can receive the override. |
