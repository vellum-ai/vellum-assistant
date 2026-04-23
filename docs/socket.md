# Socket.dev at Vellum Assistant

This doc is the operator runbook for Socket.dev on `vellum-ai/vellum-assistant`: what runs in CI, how the policy file is wired, how the weekly autofix works, where the API token comes from, and the manual `gh api` command used to wire Socket checks into `main` branch protection. The sibling repo `vellum-ai/vellum-assistant-platform` uses the **same Socket API token** and has a parallel runbook — rotating the token affects both repos.

## Tier

The vellum-ai Socket org is on **Socket Free**.

**Works on Free:**

- `socket-security` GitHub App checks on every PR.
- `socket.yml` policy file (boolean `issueRules` map).
- `socket fix` dep-upgrade autofix (requires an API token).
- ~1,000 scans/month.

**NOT available on Free:**

- Reachability analysis.
- Priority scoring.
- Slack / webhook alert channels.
- Org-wide policy enforcement.
- Socket Firewall.

## What runs in CI

### `socket-security` GitHub App (per PR)

The `socket-security` App (installed at the vellum-ai org level) emits two check runs on every PR:

- `Socket Security: Project Report` — runs on every PR.
- `Socket Security: Pull Request Alerts` — runs when a PR touches a manifest or lockfile (`package.json` / `bun.lock`).

Both are gated by `socket.yml` at the repo root.

### `Socket Fix` workflow (weekly Monday 09:00 UTC)

`.github/workflows/socket-autofix.yml` runs on `cron: '0 9 * * 1'` plus `workflow_dispatch`. (The workflow file name is historical; the workflow `name:` is `Socket Fix`.)

Because this is a multi-workspace Bun monorepo with **no root-level `package.json`**, the job uses `strategy.matrix` over the runtime-relevant workspaces that each own a `bun.lock` (`assistant`, `cli`, `credential-executor`, `gateway`, the two `clients/chrome-extension*` workspaces, the three `packages/*` workspaces, and the three `skills/meet-join*` workspaces). Each matrix leg sets `defaults.run.working-directory` to its workspace and runs `bun install --frozen-lockfile --ignore-scripts` before invoking the Socket CLI — Socket's `fix` operates on a resolved `node_modules` tree, but postinstall hooks would mutate other workspaces and contaminate the autofix diffs. `meta` and `scripts` (dev tooling only) are deliberately excluded to conserve the Free tier's ~1,000 scans/month budget.

- **`socket-fix`** — opens one PR per fixable GHSA/CVE, per workspace. Flags:
  - `--pr-limit 3` — cap per matrix leg (12 × 3 = 36 PRs/week ceiling).
  - `--minimum-release-age 1w` — skip versions published in the last 7 days. Defense against malware-via-update (compromised maintainer pushing a poisoned patch release).

Socket Certified Patches (`socket-patch`) are deferred: `socket-patch apply` modifies files in `node_modules/`, which don't persist across `bun install`. Adoption requires running `bunx @socketsecurity/socket-patch setup` per workspace to install a `postinstall: socket-patch apply` hook — a cross-workspace install-time dependency added to every workspace's `package.json`. File as a follow-up when the team is ready to take on that rollout.

## Policy file

- **Location:** `socket.yml` at the repo root.
- **Schema:** `issueRules` is a **boolean map** (`<alertName>: true|false`) per the upstream `@socketsecurity/config` v3 schema (`additionalProperties: { type: "boolean" }`). The `{ action: error|warn|ignore }` object form is **silently rejected** by Socket's config validator and falls back to dashboard defaults — do NOT reintroduce it.
- **Dashboard policy layering:** block-vs-warn granularity is **not expressible in `socket.yml`** — it lives in the **Socket dashboard Security Policies**. To change whether a specific alert blocks or warns, configure the dashboard policy at the org level rather than editing this file.
- **Extending the ignore list:** to suppress an alert category repo-wide, set it to `false`. To suppress a *specific package* that triggered an alert (e.g. esbuild for `installScripts`), use Socket's package-scoped override syntax — see https://docs.socket.dev/docs/socket-yml for the current shape. Prefer package-scoped overrides over category-wide `false`; always add a rationale comment above any suppression (why, who approved, date, expiry if any). Reviewers block suppression-without-rationale additions.

## Token provenance

- `SOCKET_CLI_API_TOKEN` is created at **Socket dashboard → Settings → API Tokens** with scopes `full-scans:create` and `packages:list`.
- Stored as a repo secret at `vellum-ai/vellum-assistant → Settings → Secrets and variables → Actions`.
- **Same token is used by the sibling `vellum-assistant-platform` repo.** One Socket token covers both repos; rotation means updating the secret in both.
- **Rotation procedure:**
  1. In the Socket dashboard, create a new token with the same scopes (`full-scans:create`, `packages:list`).
  2. Update the repo secret in both `vellum-ai/vellum-assistant` and `vellum-ai/vellum-assistant-platform`, then trigger each repo's Socket workflow manually and confirm success.
  3. Delete the old token in the Socket dashboard.
- Do NOT rotate during the Monday 09:00 UTC scheduled-run window.

## Interpreting Socket alerts on a PR

`Socket Security: Pull Request Alerts` annotates the PR with any Socket-detected issues for deps touched by the PR. `socket.yml` decides which alert categories surface; the Socket dashboard Security Policy decides whether each surfaced alert blocks or warns. Post-ruleset-PATCH (see next section), a Socket check in `error` state **blocks merge** on `main`; `warn` / `notice` surfaces in the PR but does not block. Prefer package-scoped overrides over flipping a whole alert category to `false` — the latter weakens the policy for every other dep.

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

Socket Free has ~1,000 scans/month. Each PR with a manifest/lockfile touch consumes 1 scan; each weekly `Socket Fix` run consumes one scan per matrix leg (12) plus extra per fix opened. Check monthly usage at the Socket dashboard. If usage hits **70% (~700 scans) for two consecutive months**, lower the cron cadence or upgrade to Team tier, and file a Linear ticket the first time the threshold is reached. POSIX cron can't express true biweekly cleanly. If cadence needs to drop, switch to monthly: `cron: '0 9 1 * *'` (09:00 UTC on the first of each month). A bash step gating on `$(( GITHUB_RUN_NUMBER % 2 ))` works too but lives in `run:` scripts, not `if:` expressions — document and test before relying on it.

## See also

- `SECURITY.md` — vulnerability reporting policy (the public-facing side).
- `AGENTS.md` § `Dependencies` — license-compatibility policy (Socket does not enforce license policy; that is still our gate).
- `AGENTS.md` § `GitHub Actions` — action-pin format rule (why every `uses:` in `socket-autofix.yml` has a 40-char SHA).
