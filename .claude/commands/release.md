Cut a new release by triggering the Release workflow via GitHub Actions workflow dispatch.

The user may pass `$ARGUMENTS` as the bump type: `patch`, `minor`, or `major`. If not provided, default to `patch`.

## Steps

### 1. Pull latest main

```bash
git checkout main && git pull
```

### 2. Determine the bump + next version

If the user provided `$ARGUMENTS`, treat it as the bump type (`patch`, `minor`, or `major`). Otherwise default to `patch`.

Compute the next version from the latest tag:

```bash
BUMP_TYPE="${ARGUMENTS:-patch}"
LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
LATEST_VERSION=${LATEST_TAG#v}
IFS='.' read -r MAJOR MINOR PATCH <<< "$LATEST_VERSION"

case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Invalid bump type: $BUMP_TYPE (expected patch|minor|major)"; exit 1 ;;
esac

NEXT_VERSION="${MAJOR}.${MINOR}.${PATCH}"

echo "About to release v$NEXT_VERSION (bump: $BUMP_TYPE, previous: $LATEST_TAG)"
```

Ask for confirmation before proceeding.

### 3. Check for existing tag

```bash
git tag -l "v<version>"
```

If the tag already exists, stop and tell the user.

### 4. Trigger the Release workflow

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

### 5. Verify the workflow started

```bash
gh run list --repo vellum-ai/vellum-assistant --workflow="Release" --limit 1
```

Confirm the workflow was triggered.

### 6. Report

Output:
- The version number
- A link to the running workflow
- Remind the user that the full release pipeline takes ~15-20 minutes and will auto-publish everything when done
