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
| `meet` | 2026-04-19 | sidd@vellum.ai | Platform PR not yet opened (as of 2026-04-19) | Terraform entry in `../vellum-assistant-platform/terraform/launchdarkly.tf` (or equivalent) with `defaultEnabled: false` and a description pointing at `skills/meet-join/SKILL.md`. |
| `memory-v3-shadow` | 2026-05-28 | memory-v3 owner | Platform PR not yet opened (as of 2026-05-28) | Terraform entry in `../vellum-assistant-platform/terraform/launchdarkly.tf` (or equivalent) with `defaultEnabled: false` provisioning the `memory-v3-shadow` assistant flag before it is flipped on in any hosted instance. |
| `memory-v3-live` | 2026-05-30 | memory-v3 owner | Platform PR not yet opened (as of 2026-05-30) | Terraform entry in `../vellum-assistant-platform/terraform/launchdarkly.tf` (or equivalent) with `defaultEnabled: false` provisioning the `memory-v3-live` assistant flag before it is enabled on any hosted instance. |
| `experiment-activation-flow-2026-06-03` (`variant-b` arm) | 2026-06-11 | alex@vellum.ai | Platform PR not yet opened (as of 2026-06-11) | Flag already exists in LaunchDarkly; add the `variant-b` string variation (preseeded personal-page app, JARVIS-1167) in `vellum-assistant-platform` terraform, and serve the flag to assistant-scope consumers now that the registry scope changed `client` → `both`. |
