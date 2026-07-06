---
name: release
description: >
  Cut a new release by triggering the Release workflow via GitHub Actions workflow dispatch.
---

Cut a new release by triggering the Release workflow via GitHub Actions workflow dispatch.

The workflow computes the version itself: a dispatch from `main` takes the latest `v<major>.<minor>.<patch>` tag and increments the patch number. There is no bump-type input — minor/major bumps land by changing the version on `main` first, not through this command.

## Steps

### 1. Pull latest main

```bash
git checkout main && git pull
```

The dispatch builds whatever is on `origin/main` — pulling first is so the release you announce matches what you can see locally.

### 2. Confirm the payload

Show the latest tag and the commits since it, so it's clear what the release will carry:

```bash
git describe --tags --abbrev=0
git log --oneline "$(git describe --tags --abbrev=0)"..origin/main | head -20
```

Confirm with the user before dispatching unless they already asked for the release explicitly.

### 3. Trigger the Release workflow

```bash
gh workflow run release.yml \
  --repo vellum-ai/vellum-assistant \
  --ref main
```

The only dispatch input is the optional `slack_user_id` (`--field slack_user_id=U…`), used to attribute the release notification; omit it when unknown.

The unified Release workflow automatically handles:
- Computing the next patch version from the latest tag
- Version bumping across all packages
- Creating a release branch, PR, and merging it
- Tagging the release
- Publishing npm packages
- Building, signing, notarizing, and publishing the macOS DMG
- Creating GitHub Releases on `vellum-ai/vellum-assistant`
- Updating the `vellum-assistant-platform` dependency

### 4. Verify the workflow started and read the version

```bash
gh run list --repo vellum-ai/vellum-assistant --workflow="Release" --limit 1
```

The computed version appears in the `extract-version` job log as `BASE_VERSION: <x.y.z>`.

### 5. Report

Output:
- The version number (from the `extract-version` job)
- A link to the running workflow
- Remind the user that the full release pipeline takes ~15-20 minutes and will auto-publish everything when done
