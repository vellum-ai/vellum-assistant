# Risk Classifier — Phase 2 Follow-ups

Issues to resolve before starting Phase 3. Ordered by severity.

---

## P1: `resolveSubcommand` only knows git's value flags

`resolveSubcommand` hardcodes git as the only command with global value-consuming flags:

```ts
const valueFlags = program === "git" ? GIT_VALUE_FLAGS : undefined;
```

Any CLI that takes global flags before the subcommand will misresolve. `gh --repo owner/repo pr merge` treats `owner/repo` as the first positional, misses the `pr merge` subcommand entirely, and falls back to `gh`'s base risk of `low` — a false negative on a high-risk operation. Same for `docker --host ... rm`, `npm --prefix /path test`, etc.

**Fix:** Add an optional `globalValueFlags?: string[]` field to `CommandRiskSpec`. Populate it for `gh`, `docker`, `npm`, `kubectl`, and any other command with global value-consuming flags. `resolveSubcommand` reads it from the spec instead of the hardcoded check.

---

## P2: Variable expansion escalation uses baseRisk, not current computed risk

Line 433 of `bash-risk-classifier.ts`:

```ts
const escalated = escalateOne(resolvedSpec.baseRisk);
```

If arg rules already raised risk above baseRisk, the `$VAR` escalation compares against base rather than the running max. Example: a command with `baseRisk: "low"` that matched a `medium` arg rule, with `$VAR` in args — `escalateOne("low")` = `medium`, which equals the current risk, so no escalation happens. But the dynamic content should arguably push a medium-risk command to high.

**Fix:** `escalateOne` should operate on the *current computed risk* (after arg rule evaluation), not `resolvedSpec.baseRisk`.

---

## P2: Dual scope-option systems will diverge

`checker.ts` still generates permission prompt options via `buildShellAllowlistOptions` (lines 757-763, from `shell-identity.ts`). The classifier now generates its own `scopeOptions` via `generateScopeOptions` in `bash-risk-classifier.ts`. These are two parallel systems producing scope ladders from different logic.

This is acknowledged as future work, but the longer both exist, the more they'll drift. Phase 3 should wire `RiskAssessment.scopeOptions` into the permission prompts and retire `buildShellAllowlistOptions`.

---

## P3: `command -v`/`-V` wrapper special case is ad-hoc

Lines 301-304 hardcode a check for `command -v`/`-V` as a non-exec wrapper mode:

```ts
const isCommandLookup =
  programName === "command" &&
  segment.args.length > 0 &&
  (segment.args[0] === "-v" || segment.args[0] === "-V");
```

This works but doesn't generalize. Wrappers can have non-exec modes (`command -v`, `env -0`, `timeout --help`), and `isWrapper` currently assumes wrapping always means "run the inner thing."

**Fix:** Add an optional `nonExecFlags?: string[]` field on wrapper `CommandRiskSpec`s. When the first arg matches a non-exec flag, skip unwrapping and classify the wrapper command standalone. Replaces the hardcoded check and handles future cases cleanly.

---

## P3: `rm` safe-file downgrade silently excludes flags

The `isRmOfKnownSafeFile` downgrade in `classifySegment` only fires when `segment.args.length === 1` (bare filename, no flags). So `rm -f BOOTSTRAP.md` stays high because `-f` makes `args.length === 2`.

This is *correct* behavior (conservative), but surprising — `-f` doesn't make the operation more dangerous. Worth either:
- Expanding the guard to strip known-benign rm flags (`-f`, `-i`, `-v`) before checking, or
- Adding an inline comment explaining why flags disqualify the downgrade.

---

## Nits

- **`riskOrd` fallback is dead code.** The `?? 2` on line 50 can never fire since `Risk` is a closed union. Add a `// defensive fallback` comment or remove.
- **Regex cache never clears.** `compiledPatterns` is module-level. Fine for the static default registry, but if user rules with regex patterns get hot-swapped at runtime, stale entries accumulate. Consider exposing `clearCompiledPatterns()` for tests or a cache-invalidation hook.
- **`go` base risk inconsistency.** `go` has `baseRisk: "low"` but `npm` has `baseRisk: "medium"`. Both are package managers that can execute arbitrary code. Bare `go` (no subcommand) just prints help, so low is defensible — but worth a comment explaining the asymmetry since `go get` and `go generate` exist.
