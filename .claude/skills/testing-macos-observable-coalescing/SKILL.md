---
name: testing-macos-observable-coalescing
description: Verify `@Observable` + `didSet` write-coalescing changes in the macOS client (e.g. snapshot-mutate-writeback PRs like LUM-1138). Use when reviewing or testing a PR that refactors per-row writes to an `@Observable` stored property into a single coalesced writeback.
---

Use this skill when a PR touches an `@Observable` macOS class whose stored property has `didSet { recomputeDerivedProperties() }` (or similar heavy derived work) and the change is meant to collapse N writes-in-a-loop into 1.

## Environment constraints

- Devin VMs are Linux. There is **no Swift compiler or Xcode** — `swift test`, `swift build`, and `xcodebuild` are not available.
- CI for `vellum-ai/vellum-assistant` **skips `macOS Build`, `macOS Tests`, and `Lint Unused Code`** (they are listed as optional and skipped on every PR). Only the non-macOS required checks run (Socket Security, FlexFrame Lint).
- The user must run the Xcode build and `xcodebuild test` locally to fully verify behavior. **Always mention this when sharing test results.**

Given those constraints, the right testing approach is structural verification — proving the diff applies the snapshot pattern correctly and consistently to every hot path, plus inspecting the new regression tests for correctness.

## Standard verification checklist

For every N-write hot path the PR claims to fix, verify these four properties via `grep` / `read`. If any fail, stop and message the user.

### 1. Snapshot variable exists and is mutated, not the live property

Inside the function body, there should be exactly one declaration of the form `var snapshot = <property>` (e.g. `var snapshot = conversations`) followed by mutations on `snapshot[...]` / `snapshot.append(...)` and a single writeback `<property> = snapshot` after the loop.

```bash
# Should find exactly one `var snapshot = <property>` and one `<property> = snapshot`.
grep -n "var snapshot = conversations" path/to/Store.swift
grep -n "conversations = snapshot" path/to/Store.swift
```

### 2. Zero per-row writes to the live property inside the loop

Inside the loop body, there should be **zero** subscript writes (`property[i] = ...`) or full-array assignments (`property = ...`) to the live `@Observable` property. Every mutation should target the snapshot.

```bash
# Extract just the loop body and confirm no live-property writes remain.
sed -n '<loop_start>,<loop_end>p' path/to/Store.swift | grep -n "conversations\["
# Expect: no output (or only matches that are reads, like `let x = conversations[idx]`).
```

When a `grep` finds matches, distinguish reads from writes by inspecting the matched lines — only writes (`property[i] = ...`) are problematic.

### 3. Loop uses a value-level helper, not the live-property mutator

If the original code called something like `mergeAttention(intoConversationAt: index)` (which writes to `conversations[index]` internally), the refactor should expose a value-level variant taking `inout` (e.g. `applyAttention(into: &snapshot[i])`) and the loop should call the new variant. The old `intoConversationAt:` wrapper may remain for single-row callers but must not be called from any loop.

```bash
# Audit all callers of the live-property mutator across the codebase.
grep -rn "mergeAssistantAttention" clients/macos/ --include="*.swift" | grep -v "func mergeAssistantAttention"
# Expect: only single-row callers + protocol/forwarder definitions, no in-loop usages.
```

### 4. The value-level helper itself does not write to the live property

The new helper (e.g. `applyAttention(into:)`) must accept `inout` and write only to the inout parameter and `@ObservationIgnored` bookkeeping (e.g. caches/override dictionaries). It must not touch `self.<property>` or `self.<property>[i]`.

```bash
# Read the function body and confirm zero writes to the live property.
sed -n '<helper_start>,<helper_end>p' path/to/Store.swift | grep -nE "(conversations\[|self\.conversations =)"
# Expect: no output.
```

Also confirm any side-effecting state the helper touches (e.g. `pendingAttentionOverrides`) is `@ObservationIgnored` so mutations don't fire observation notifications inside the loop.

## Regression tests to expect / verify

A correct fix should include tests in `ConversationListStoreObservationTests.swift` (or analogous file) that:

- Seed multiple rows in the live property.
- Wire a recompute counter via the store's `onDerivedPropertiesRecomputed` callback (or equivalent).
- Reset the counter after seeding.
- Process a multi-row batch (the function under test).
- `#expect(recomputeCount == 1, ...)` — exactly one recompute regardless of N.

A second test should confirm the value-level helper alone triggers zero `didSet` (`#expect(recomputeCount == 0)`) when applied to an `inout` value.

The tests use the `swift-testing` framework (`@Test` + `#expect`) — match the style of the surrounding file.

## AGENTS.md guideline

This pattern is documented in `clients/AGENTS.md` (search for "Coalesce N writes into one"). If a PR introduces a new N-write hot path that gets fixed, verify the guideline still references the canonical examples; if a new example was added (e.g. `appendConversations`), it should be referenced alongside the existing `markConversationsSeenImpl`, `restoreUnseen`, `deleteGroup`.

## Reporting test results

When reporting back to the user:

1. **Lead with the escalation**: you cannot run `xcodebuild test`, so the regression tests are structurally verified only — they must still be run locally.
2. State that CI skipped `macOS Build`, `macOS Tests`, and `Lint Unused Code` (as expected — no macOS in CI).
3. List each verification check as a single bullet with `passed` / `failed` / `untested`. Only elaborate on failures or unexpected results.
4. Recommend the user (a) runs the new tests via Cmd+U in Xcode, (b) exercises the affected flows manually (initial load, scroll-to-load-more, reconnect, fork/archive — whatever flows the PR touches), and (c) monitors the related Sentry issue for 1–2 weeks post-release.
5. Post a single PR comment (`git_comment`) with the test results, using `<details>` for the structural details. Pre-expand the summary list.

## Why no recording

This kind of fix has no UI rendering change — all behavior change is observation/timing only. There is nothing visual to record. Don't start a screen recording for structural-verification testing.

## Devin secrets needed

None — all verification is local file inspection.
