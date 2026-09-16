# Plugin Marketplace

[`plugins/marketplace.json`](../plugins/marketplace.json) is the canonical
inventory for reviewed plugins. Each entry has one source:

- `github` identifies an immutable repository commit and an optional package
  path.
- `local` identifies an exact package path and version embedded in the
  assistant distribution. It never resolves a path from the workspace or the
  process working directory.

The catalog is platform-first when platform features are enabled. The
assistant merges local packages from its bundled copy after a successful
platform response, with platform entries winning duplicate names. Platform
errors still fail the catalog request and are never replaced by a stale or
offline response. When platform features are disabled, the full bundled
manifest supplies the catalog.

`assistant/scripts/generate-bundled-plugin-packages.ts` validates every local
package and generates the embedded file map used by the installer. A local
package must be a standard plugin with matching name and version, a valid
`mcp.json`, canonical paths, and no symlinks. Build and Docker packaging fail if
any declared package is invalid or unavailable.

The normal plugin installer handles both source kinds and records the exact
source in the install sidecar. Local update checks only versions embedded in
the running assistant and keeps the installed package path fixed. A catalog
source change requires an explicit reinstall, so an update cannot silently
move an existing install between GitHub and the assistant bundle.
