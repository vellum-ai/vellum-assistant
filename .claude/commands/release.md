Cut a new release by creating a tagged GitHub Release.

The user may pass `$ARGUMENTS` as the version (e.g. `0.2.0` or `v0.2.0`). If not provided, auto-increment the patch version from the latest tag.

## Steps

### 1. Pull latest main

```bash
git checkout main && git pull
```

### 2. Determine the version

If the user provided `$ARGUMENTS`, use it as the version (strip leading `v` if present, then re-add it for the tag).

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

### 4. Generate release notes

Look at the commits since the last tag to build release notes:

```bash
git log <previous-tag>..HEAD --oneline
```

Group changes into categories:
- **Features**: new functionality
- **Fixes**: bug fixes
- **Infrastructure**: CI, build, tooling changes
- **Other**: anything else

Write concise, user-facing descriptions (not raw commit messages).

### 5. Create the GitHub Release

```bash
gh release create v<version> \
  --title "v<version>" \
  --notes "<release notes>"
```

This automatically creates the git tag and triggers any `on: release` workflows.

### 6. Verify the workflow started

```bash
gh run list --limit 1
```

Confirm a build was triggered (if applicable).

### 7. Report

Output:
- The release URL
- The version number
- The release notes
