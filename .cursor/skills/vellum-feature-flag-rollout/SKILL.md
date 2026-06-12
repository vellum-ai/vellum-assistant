---
name: vellum-feature-flag-rollout
description: Guide Vellum Assistant feature flag changes and rollout hygiene. Use when adding, editing, reviewing, or documenting assistant feature flags, rollout-gated behavior, or platform flag follow-up work.
---

# Vellum Feature Flag Rollout

## Flag Rules

Assistant feature flags use simple kebab-case keys and must be declared in:

```text
meta/feature-flags/feature-flag-registry.json
```

New flags require:

- `scope: "assistant"`
- a canonical kebab-case key
- a safe default
- tests or guard coverage when resolver behavior changes
- a companion `vellum-assistant-platform` PR to provision the flag in Terraform

## Rollout Hygiene

There is no release-note surfacing mechanism — the workspace-bulletin feature was removed and the historical release-note migrations are frozen. Do not add new release-note migrations for any feature (flagged or GA). If a release needs user-facing notes, design an explicit on-demand surfacing mechanism first.

## Permission Controls V2

Under `permission-controls-v2`, do not add new deterministic approval modes for assistant-owned actions beyond the conversation-scoped host computer access gate. Avoid global toggles, persistent trust-rule UI, wildcard scopes, and time-window approvals.

## Review Workflow

1. Confirm whether the change adds, renames, removes, or consumes a flag.
2. Check registry declaration and key format.
3. Check default behavior and rollout safety.
4. Check docs, release notes, and user-facing copy for flag leaks.
5. Check whether the platform repo needs a Terraform update.
6. Recommend focused tests for resolver, route, UI, or behavior changes.

## PR Notes

Call out:

- flag key
- default state
- rollout plan
- companion platform PR status
- whether release notes are intentionally omitted
