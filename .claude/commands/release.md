Cut a new release by triggering the Release workflow via GitHub Actions workflow dispatch.

The user may pass `$ARGUMENTS` as the version (e.g. `0.2.0` or `v0.2.0`). If not provided, auto-increment the patch version from the latest tag.

## Steps

### 1. Pull latest main

```bash
git checkout main && git pull
```

### 2. Determine the version

If the user provided `$ARGUMENTS`, use it as the version (strip leading `v` if present).

If no version was provided, find the latest tag and auto-increment the patch version:

```bash
git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0"
```

For example: `v0.1.1` → `v0.1.2`, `v1.2.3` → `v1.2.4`.

Show the user the version you're about to release and ask for confirmation before proceeding.

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
  --field version=<version>
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
