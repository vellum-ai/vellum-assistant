# Pending Platform PRs for Feature Flags

This file tracks assistant feature flags that have been declared in
`feature-flag-registry.json` but do not yet have a corresponding
LaunchDarkly/Terraform entry in the `vellum-assistant-platform` repo. Per
`CLAUDE.md` (see the Assistant Feature Flags section) and
`meta/feature-flags/AGENTS.md`, a new flag in this registry requires a
companion PR in `vellum-assistant-platform` to provision the flag on the
platform for remote sync.

Remove an entry from this file once its companion platform PR is merged.

## Open entries

| Flag key | Registry declaration date | Owner | Status | Required platform work |
|---|---|---|---|---|
| `meet` | 2026-04-19 | sidd@vellum.ai | Platform PR not yet opened (as of 2026-04-19) | Terraform entry in `../vellum-assistant-platform/terraform/launchdarkly.tf` (or equivalent) with `defaultEnabled: false` and a description pointing at `skills/meet-join/SKILL.md`. |
