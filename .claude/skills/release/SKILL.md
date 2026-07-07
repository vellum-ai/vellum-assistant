---
name: release
description: >
  Cut a new release: create the release branch (staging bake), then dispatch the
  production Release run on that branch.
---

Cut a new release. Releases are a **two-step** process:

1. **Branch cut → staging bake**: `create-release-branch.yml` computes the version from the bump type, deletes any stale `release/v<X.Y.Z>` branch, cuts a fresh one from `main` HEAD with the version-bump commit, and pushes it. That push triggers a `Release` run on the branch which is a **staging** deploy (push-triggered and main-dispatched `Release` runs are always staging).
2. **Production**: dispatching `release.yml` **on the `release/v<X.Y.Z>` branch** runs the full production release — tag, GitHub Release, DMG sign/notarize/publish, npm packages, Docker Hub images, iOS TestFlight, platform dependency bump, and the merge-back of the release branch to `main`.

The scheduled Tue/Fri 9am ET cut performs step 1 automatically; a human performs step 2 after the staging bake is green. A `release/v<X.Y.Z>` branch with no corresponding GitHub Release means a cut was never promoted — re-running step 1 refreshes it from current `main`.

The user may pass `$ARGUMENTS` as the bump type for step 1: `patch`, `minor`, `major`, or `hotfix` (patch cut from the latest release tag's commit instead of `main`, pushed `[skip ci]` for manual cherry-picks). Default to `patch`.

## Steps

### 1. Pull latest main and show the payload

```bash
git checkout main && git pull
git describe --tags --abbrev=0
git log --oneline "$(git describe --tags --abbrev=0)"..origin/main | head -20
```

Confirm with the user before proceeding unless they already asked for the release explicitly.

### 2. Cut the release branch (staging bake)

```bash
gh workflow run create-release-branch.yml \
  --repo vellum-ai/vellum-assistant \
  --ref main \
  --field bump=<patch|minor|major|hotfix>
```

Then wait for the branch cut and find the staging `Release` run its push triggered:

```bash
gh run list --workflow="Create Release Branch" --limit 1
gh run list --workflow=Release --branch "release/v<X.Y.Z>" --limit 1
```

The version appears in the branch name; the staging run takes ~15-20 minutes. **Wait for it to succeed** — it is the CI bake for the exact release payload. If it fails, fix `main` and re-run this step (it recuts the branch from `main` HEAD).

### 3. Dispatch the production release

```bash
gh workflow run release.yml \
  --repo vellum-ai/vellum-assistant \
  --ref "release/v<X.Y.Z>"
```

The only dispatch input is the optional `slack_user_id` (`--field slack_user_id=U…`) for the release notification; omit it when unknown.

### 4. Verify

The production run takes ~20 minutes. When it completes:

```bash
gh release list --limit 1        # v<X.Y.Z> should be Latest
git fetch --tags && git tag -l "v<X.Y.Z>"
git log --oneline origin/main -1 # merge-back commit "Release v<X.Y.Z>"
```

If the merge-back to main failed, the run's Slack notification includes the manual-merge command.

### 5. Report

Output:
- The version number and a link to the production run
- Confirmation that the GitHub Release, tag, and merge-back all landed
