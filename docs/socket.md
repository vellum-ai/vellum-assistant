# Socket.dev at Vellum Assistant

This doc is the operator runbook for Socket.dev on `vellum-ai/vellum-assistant`: what runs in CI, how the policy file is wired, how the weekly autofix works, where the API token comes from, and the manual `gh api` command used to wire Socket checks into `main` branch protection. The sibling repo `vellum-ai/vellum-assistant-platform` uses the **same Socket API token** and has a parallel runbook — rotating the token affects both repos.

## Tier

The vellum-ai Socket org is on **Socket Free**.

**Works on Free:**

- `socket-security` GitHub App checks on every PR.
- `socket.yml` policy file (boolean `issueRules` map).
- `socket fix` dep-upgrade autofix (requires an API token).
- Free-tier Socket Certified Patches via `socket-patch` (no token needed).
- ~1,000 scans/month.

**NOT available on Free:**

- Reachability analysis.
- Priority scoring.
- Slack / webhook alert channels.
- Paid-tier Certified Patches — `socket-patch` silently skips these; expected.
- Org-wide policy enforcement.
- Socket Firewall.

## What runs in CI

### `socket-security` GitHub App (per PR)

The `socket-security` App (installed at the vellum-ai org level) emits two check runs on every PR:

- `Socket Security: Project Report` — runs on every PR.
- `Socket Security: Pull Request Alerts` — runs when a PR touches a manifest or lockfile (`package.json` / `bun.lock`).

Both are gated by `socket.yml` at the repo root.

### `Socket Autofix` workflow (weekly Monday 09:00 UTC)

`.github/workflows/socket-autofix.yml` runs on `cron: '0 9 * * 1'` plus `workflow_dispatch`. It contains two **independent** jobs (no `needs:` between them) that run in parallel:

- **`socket-fix`** — opens one PR per fixable GHSA/CVE. Flags:
  - `--pr-limit 10` — cap per-run PR volume. Socket's current default, pinned explicitly for reviewer visibility and future-default stability.
  - `--minimum-release-age 1w` — skip versions published in the last 7 days. Defense against malware-via-update (compromised maintainer pushing a poisoned patch release).
- **`socket-patch`** — applies Socket Certified Patches, bundled into one PR. Paid-tier patches are silently skipped on Free (expected — no PR opened those weeks).

## Policy file

- **Location:** `socket.yml` at the repo root.
- **Schema:** `issueRules` is a **boolean map** (`<alertName>: true|false`) per the upstream `@socketsecurity/config` v3 schema (`additionalProperties: { type: "boolean" }`). The `{ action: error|warn|ignore }` object form is **silently rejected** by Socket's config validator and falls back to dashboard defaults — do NOT reintroduce it.
- **Two states in YAML:** `true` enables the alert (it will surface on the Socket PR check); `false` suppresses it. Block-vs-warn granularity is **not expressible in `socket.yml`** — it lives in the **Socket dashboard Security Policies**. To change whether a specific alert blocks or warns, configure the dashboard policy at the org level rather than editing this file.
- **Extending the ignore list:** to suppress an alert category repo-wide, set it to `false`. To suppress a *specific package* that triggered an alert (e.g. esbuild for `installScripts`), use Socket's package-scoped override syntax — see https://docs.socket.dev/docs/socket-yml for the current shape. Prefer package-scoped overrides over category-wide `false`; always add a rationale comment above any suppression (why, who approved, date, expiry if any). Reviewers block suppression-without-rationale additions.
- **Ecosystems:** currently npm/Bun only. The App auto-detects Python manifests if they land; `issueRules` apply across ecosystems, so no YAML change is needed for a new ecosystem unless we want divergent per-ecosystem policy.

## Token provenance

- `SOCKET_CLI_API_TOKEN` is created at **Socket dashboard → Settings → API Tokens** with scopes `full-scans:create` and `packages:list`.
- Stored as a repo secret at `vellum-ai/vellum-assistant → Settings → Secrets and variables → Actions`.
- **Same token is used by the sibling `vellum-assistant-platform` repo.** One Socket token covers both repos; rotation means updating the secret in both.
- **Rotation procedure:**
  1. In the Socket dashboard, create a new token with the same scopes (`full-scans:create`, `packages:list`).
  2. Update the repo secret in `vellum-ai/vellum-assistant` → trigger `Socket Autofix` manually → confirm `socket-fix` succeeds.
  3. Update the repo secret in `vellum-ai/vellum-assistant-platform` → trigger its workflow manually → confirm success.
  4. Delete the old token in the Socket dashboard.
- Do NOT rotate during the Monday 09:00 UTC scheduled-run window.
- Job 2 (`socket-patch`) does NOT consume the token — token rotation cannot break `socket-patch`.

## Interpreting Socket alerts on a PR

`Socket Security: Pull Request Alerts` annotates the PR with any Socket-detected issues for deps touched by the PR. Whether an alert **blocks** the check or shows as a warning is controlled by **two layers**:

1. **`socket.yml`** — `<alertName>: true` enables the alert category; `<alertName>: false` suppresses it entirely.
2. **Socket dashboard Security Policy** — maps enabled alerts to block / warn / notice severities at the org level. This is where warn-vs-block granularity lives.

Post-ruleset-PATCH (see next section), a Socket check in `error` state (per dashboard policy) **blocks merge** on `main`. A check in `warn` / `notice` surfaces in the PR but does not block.

See `## Policy file` for suppression syntax. Prefer package-scoped overrides over flipping a whole alert category to `false` — the latter weakens the policy for every other dep.

## Ruleset PATCH — wire Socket checks into `main` branch protection

Manual operator step, NOT a code change. Run after PRs 1 and 2 are merged and after a trivial sanity PR (one-line `package.json` edit or `bun.lock` touch) confirms both App checks run green.

Ruleset ID: **`12614752`** ("Main Protection" on `main`).

### Step A — snapshot the existing ruleset

```bash
gh api /repos/vellum-ai/vellum-assistant/rulesets/12614752 > /tmp/main-ruleset.json
```

### Step B — verify the pre-PATCH baseline

Expected: review rule present (`approving_review_count=1`, `dismiss_stale_reviews_on_push=true`, `require_last_push_approval=true`); no `required_status_checks` rule.

```bash
jq '.rules[] | select(.type == "pull_request") | .parameters' /tmp/main-ruleset.json

# Should print nothing — no required_status_checks rule today.
jq '.rules[] | select(.type == "required_status_checks")' /tmp/main-ruleset.json
```

### Step C — apply the PATCH

The GitHub ruleset API expects the full ruleset body on PUT. The `jq` filter below rebuilds `{ name, target, enforcement, bypass_actors, conditions, rules }` from the snapshot and only **appends** a new `required_status_checks` rule with both Socket contexts. Review rules, dismiss-stale, and last-push-approval are preserved untouched.

```bash
jq '
  .rules += [{
    "type": "required_status_checks",
    "parameters": {
      "strict_required_status_checks_policy": false,
      "do_not_enforce_on_create": false,
      "required_status_checks": [
        { "context": "Socket Security: Pull Request Alerts" },
        { "context": "Socket Security: Project Report"     }
      ]
    }
  }]
  | { name, target, enforcement, bypass_actors, conditions, rules }
' /tmp/main-ruleset.json > /tmp/main-ruleset-patched.json

gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/vellum-ai/vellum-assistant/rulesets/12614752 \
  --input /tmp/main-ruleset-patched.json
```

Payload notes:

- `--method PUT` is required — the ruleset update endpoint is PUT (not PATCH); using PATCH will 404.
- `strict_required_status_checks_policy: false` — do not require PR branches to be up-to-date with `main` before merging. Matches current behavior; flipping to `true` is a separate follow-up.
- `do_not_enforce_on_create: false` — apply the rule to branches created after the ruleset is updated.
- `context` is the check-run name emitted by the `socket-security` App — exact strings. If GitHub returns an app-integration ambiguity error, add `"integration_id": <socket-app-id>` to each entry. Look up the App ID via:

  ```bash
  gh api /repos/vellum-ai/vellum-assistant/installations \
    --jq '.installations[] | select(.app_slug == "socket-security") | .app_id'
  ```

### Step D — verify post-PATCH state

```bash
# Expected: both Socket contexts listed.
gh api /repos/vellum-ai/vellum-assistant/rulesets/12614752 | \
  jq '.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks'

# Expected: review rule unchanged (approving_review_count=1,
# dismiss_stale_reviews_on_push=true, require_last_push_approval=true).
gh api /repos/vellum-ai/vellum-assistant/rulesets/12614752 | \
  jq '.rules[] | select(.type == "pull_request") | .parameters'
```

### Step E — sanity PR

Open a small PR that touches `assistant/package.json` (or any dependency manifest) and confirm `Socket Security: Pull Request Alerts` now shows as a **required** check on the PR.

## Scan-count watch

Socket Free has ~1,000 scans/month. Consumption sources in this repo:

- Each PR with a manifest/lockfile touch → 1 scan by the App.
- Each `Socket Autofix` run → multiple scans depending on fix count.

Check monthly usage at the Socket dashboard. If usage hits **70% (~700 scans) for two consecutive months**, revisit by either:

- lowering `Socket Autofix` cadence. Note: POSIX cron has no true biweekly expression — when both day-of-month and day-of-week are constrained, cron ORs them, so `'0 9 */14 * 1'` fires *more* often than weekly, not less. Options: (a) switch to monthly with `cron: '0 9 1 * *'` (runs 09:00 UTC on the 1st of every month); (b) keep the weekly cron and gate the run with a workflow-level `if: (github.run_number % 2) == 0` so only every other run executes; or (c) drive from an external scheduler via `workflow_dispatch`.
- upgrading to Team tier.

File a Linear ticket the first time the threshold is reached.

## Follow-ups / deferred

- Introduce a GitHub Terraform provider to manage the ruleset declaratively. Today the ruleset is managed by `gh api` only. Track as a separate ticket.
- Extend `socket.yml` with a Python ecosystem block when/if Python manifests land in this repo (none today).
- Wire Socket alerts into Slack — requires Team tier; re-evaluate at tier upgrade.
- Automate scan-count monitoring. Socket does not emit a public usage API on Free, so a monthly manual check is the only option today.

## See also

- `SECURITY.md` — vulnerability reporting policy (the public-facing side).
- `AGENTS.md` § `Dependencies` — license-compatibility policy (Socket does not enforce license policy; that is still our gate).
- `AGENTS.md` § `GitHub Actions` — action-pin format rule (why every `uses:` in `socket-autofix.yml` has a 40-char SHA).
