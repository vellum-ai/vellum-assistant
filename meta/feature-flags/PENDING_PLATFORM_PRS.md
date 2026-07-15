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
| `channel-trust-floors` | 2026-06-17 | admission policy owner | Platform PR not yet opened (as of 2026-06-17) | Terraform entry in `../vellum-assistant-platform/terraform/launchdarkly.tf` (or equivalent) with `defaultEnabled: true` (registry default flipped on 2026-07-10) provisioning the `channel-trust-floors` assistant flag, which gates the Channel Trust Floors (per-channel admission policy) Privacy settings card. |
| `mcp-add-server` | 2026-06-23 | MCP settings owner | Platform PR not yet opened (as of 2026-06-23) | Terraform entry in `../vellum-assistant-platform/terraform/launchdarkly.tf` (or equivalent) with `defaultEnabled: false` provisioning the `mcp-add-server` assistant flag, which gates the Add Server action on the MCP settings page. |
| `memory-concept-graph` | 2026-07-01 | memory concept graph owner | Platform PR not yet opened (as of 2026-07-01) | Terraform entry in `../vellum-assistant-platform/terraform/launchdarkly.tf` (or equivalent) with `defaultEnabled: false` provisioning the `memory-concept-graph` assistant flag, which gates the memory concept graph on the assistant identity page (and the backend-agnostic `/memory-graph` + `/memory-graph-node` routes). Needed so managed assistants can receive a remote override; until then the flag resolves to the registry default (off) and falls back to the skills constellation. |
| `proactive-tips` | 2026-07-15 | proactive tips owner | Platform PR not yet opened (as of 2026-07-15) | Terraform entry in `../vellum-assistant-platform/terraform/launchdarkly.tf` (or equivalent) provisioning the client-scoped `proactive-tips` string flag with variations `off`/`on` and default `off`. Gates the dismissible proactive tip card in the web sidebar; string-valued so future A/B arms slot in as new values. |
