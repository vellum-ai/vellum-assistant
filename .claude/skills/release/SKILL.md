---
name: release
description: >
  Cut a new release by triggering the Release workflow via GitHub Actions workflow dispatch.
---

Cut a new release by triggering the Release workflow via GitHub Actions workflow dispatch.

The user may pass `$ARGUMENTS` as the bump type: `patch`, `minor`, or `major`. If not provided, default to `patch`.

## Steps

### 1. Pull latest main

```bash
git checkout main && git pull
```

### 2. Determine the bump type

If the user provided `$ARGUMENTS`, treat it as the bump type (`patch`, `minor`, or `major`). Otherwise default to `patch`.

Validate + show what you're about to do and ask for confirmation before proceeding:

```bash
BUMP_TYPE="${ARGUMENTS:-patch}"
case "$BUMP_TYPE" in
  patch|minor|major) ;;
  *) echo "Invalid bump type: $BUMP_TYPE (expected patch|minor|major)"; exit 1 ;;
esac

echo "About to trigger a $BUMP_TYPE release bump"
```

### 3. Trigger the Release workflow

```bash
gh workflow run release.yml \
  --repo vellum-ai/vellum-assistant \
  --ref main \
  --field bump=<patch|minor|major>
```

This triggers the unified Release workflow which automatically handles:
- Version bumping across all packages
- Creating a release branch, PR, and merging it
- Tagging the release
- Publishing npm packages
- Building, signing, notarizing, and publishing the macOS DMG
- Creating GitHub Releases on both `vellum-ai/vellum-assistant` and `vellum-ai/velly`
- Updating the `vellum-assistant-platform` dependency

To manually publish individual Docker images to GCR (e.g. for hotfixes or re-publishing):

```bash
bun scripts/gcr-publish.ts --version <semver> --services trust-broker
bun scripts/gcr-publish.ts --version <semver> --services assistant,gateway --dry-run
```

### 4. Verify the workflow started

```bash
gh run list --repo vellum-ai/vellum-assistant --workflow="Release" --limit 1
```

Confirm the workflow was triggered.

### 5. Report

Output:
- The version number (from the workflow output)
- A link to the running workflow
- Remind the user that the full release pipeline takes ~15-20 minutes and will auto-publish everything when done
