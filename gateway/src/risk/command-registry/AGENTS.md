# Command Registry — Agent Instructions

This directory contains the default bash command risk registry used by
`gateway/src/risk/bash-risk-classifier.ts`.

## Layout

- `index.ts` exports `DEFAULT_COMMAND_REGISTRY` by composing per-command specs.
- `commands/<name>.ts` defines one `CommandRiskSpec` per top-level command.

## Adding Or Updating A Command

1. Add or edit `commands/<command>.ts`.
2. Update `index.ts` imports and map entry for the command.
3. Keep specs JSON-serializable (`risk-types.ts` contract):
   - no functions,
   - no native `RegExp` objects (use regex strings),
   - only `low | medium | high` as `baseRisk`/arg rule risk.
4. Prefer explicit subcommand trees over broad implicit defaults.
5. Set `reason` when risk is non-obvious or high-impact.

## Arg Rule Conventions

- `ArgRule.id` must be globally unique across the whole registry.
- Use `command:descriptor` naming (example: `curl:upload-file`).
- If an arg rule has both `flags` and `valuePattern`, those flags must be in
  that command's `argSchema.valueFlags` (guarded by tests).

## Assistant CLI Coverage

`commands/assistant.ts` is special:

- It must stay in sync with supported CLI command paths from
  `assistant/src/cli/commands` and `assistant/src/cli/program.ts`.
- When adding/removing/renaming assistant CLI subcommands, update:
  - the supported path list,
  - risk overrides,
  - related tests in `gateway/src/risk/command-registry.test.ts` and
    `gateway/src/risk/bash-risk-classifier.test.ts`.
- Feature-gated CLI groups (for example `domain`/`email`) should still be
  represented so risk coverage does not depend on local feature-flag state.

## Risk Assignment Guidelines

- `low`: read-only / informational operations.
- `medium`: state mutations, network side effects, non-destructive writes.
- `high`: secret exposure, destructive actions, privilege/trust changes,
  arbitrary code execution, or potentially irreversible effects.

When uncertain, choose the safer default (`medium` or `high`) and add a
specific de-escalating rule for known safe forms.

## Validation

After registry changes, run scoped checks from `gateway/`:

1. `bun test src/risk/command-registry.test.ts src/risk/bash-risk-classifier.test.ts src/risk/risk-classifier-parity.test.ts src/__tests__/bash-risk-classifier.test.ts`
2. `bunx tsc --noEmit`

When `commands/assistant.ts` changes, also run from `assistant/`:

1. `bun test src/__tests__/cli-command-risk-guard.test.ts`
