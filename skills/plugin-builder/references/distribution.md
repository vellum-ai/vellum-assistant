# Distribution

Plugins ship through a curated marketplace and install by name from the CLI. This reference covers the catalog, the install flow, the manifest that lists every installable plugin, and how to install a plugin directly from a GitHub URL before it is in the catalog.

A plugin does not have to live in your workspace to be installed. Vellum keeps a curated catalog of external plugins, and the CLI installs any of them by name. The catalog is a single manifest the Vellum team reviews and approves, so installing a catalog plugin only ever pulls code that has been vetted into that list.

For plugins not yet in the catalog, the CLI also accepts a GitHub URL directly. See "Installing from a GitHub URL (untrusted)" below.

## Publishing your plugin

Once your plugin works locally, you can list it in the marketplace catalog so anyone can install it by name. The catalog is a curated allowlist: you open a PR adding an entry, the Vellum team reviews it, and once merged the plugin is discoverable via `assistant plugins search` and installable via `assistant plugins install`.

### 1. Push your plugin to a public GitHub repo

The marketplace resolves plugins from GitHub repositories. Push your plugin to a public repo, then note the full commit SHA you want to pin:

```
# Get the full 40-char commit SHA of the revision to publish
$ git rev-parse HEAD
e83c5163316f89bfbde7d9ab23ca2e25604af290
```

The SHA must be a full commit hash (40 or 64 hex chars). Tags and branches are rejected because they are mutable. If you want to pin a release tag, resolve it to the underlying commit first (see "Why entries pin a commit" below).

Your plugin can live at the root of its own repo or in a subdirectory. If it is not at the root, use `source.path` to point at the subdirectory.

### 2. Add your entry to `marketplace.json`

Open a PR against [`vellum-ai/vellum-assistant`](https://github.com/vellum-ai/vellum-assistant) adding your plugin to `plugins/marketplace.json`. Copy this template and fill in your details:

```json
{
  "name": "my-plugin",
  "source": {
    "source": "github",
    "repo": "you/my-plugin",
    "ref": "e83c5163316f89bfbde7d9ab23ca2e25604af290"
  },
  "description": "One-line summary shown in the catalog.",
  "category": "productivity",
  "homepage": "https://github.com/you/my-plugin",
  "license": "MIT"
}
```

The `name` must be a single kebab-case segment (e.g. `my-plugin`, not `myPlugin` or `my_plugin`). Only `name`, `source.source`, `source.repo`, and `source.ref` are required; the rest are optional but recommended for discoverability. See "The marketplace manifest" below for the full schema.

### 3. Wait for review

The Vellum team reviews each entry before it lands in the catalog. The review checks that:

- The pinned commit matches a public, reachable revision of the repo.
- The plugin has a valid `package.json` with a `@vellumai/plugin-api` peer dependency.
- The plugin loads cleanly (hooks register, tools validate, no import errors at boot).
- The surfaces the plugin claims (hooks, tools, skills, routes, apps) contribute something on boot rather than silently failing.

Once the review approves and the PR merges, the plugin appears in `assistant plugins search` and is installable by name.

## The marketplace catalog

The catalog is computed live from [`plugins/marketplace.json`](https://github.com/vellum-ai/vellum-assistant/blob/main/plugins/marketplace.json) in the assistant repo. It lets Vellum surface plugins that live in other repositories without copying their code, and its shape is a subset of the [Claude Code marketplace schema](https://code.claude.com/docs/en/plugin-marketplaces), so the format is familiar if you have published there.

- **Curation is the allowlist.** Only repositories listed in the manifest appear in the catalog. There is no open registry, and the Vellum team reviews each entry before it lands.
- **The manifest is the catalog.** It is the sole source of installable plugins. A missing or malformed manifest yields an empty catalog rather than falling back to anything else.
- **One surface, two clients.** The same catalog backs `assistant plugins search` and the in-product Plugins tab.

## Installing a plugin

Install by name. The CLI resolves the entry, shallow-clones the repository at its pinned commit, and writes the plugin into your workspace where the loader discovers it on the next start.

```
# Find a plugin in the catalog
$ assistant plugins search memory
NAME           PATH
simple-memory  vellum-ai/simple-memory

# Install it by name (clones the pinned commit)
$ assistant plugins install simple-memory
Installed plugin "simple-memory" (12 files) at ed09a4c -> ~/.vellum/workspace/plugins/simple-memory
The new plugin is picked up automatically.

# Confirm what is installed
$ assistant plugins list
NAME           VERSION  STATUS
simple-memory  0.1.0    ok
```

The plugins command group is gated behind a beta feature flag while the install path stabilizes. Once installed, a plugin is just a directory in your workspace, so everything on the Plugins reference applies to it.

## Installing from a GitHub URL (untrusted)

While a plugin is still under development, before it is whitelisted in the catalog, you can install it directly from its GitHub repo by passing a URL (anything containing a slash) instead of a marketplace name:

```
# Install from a repo URL (default branch)
$ assistant plugins install https://github.com/owner/repo
⚠ Installing "repo" from an unreviewed GitHub source: owner/repo @ default branch.
 This plugin is NOT in the Vellum marketplace and has not been reviewed.
 Its hooks and tools run inside the assistant with full access — install it only if you trust the source.
Installed untrusted plugin "repo" (8 files) → ~/.vellum/workspace/plugins/repo

# Install from a specific branch and sub-path
$ assistant plugins install https://github.com/owner/repo/tree/my-branch/packages/cool-plugin

# Install with a custom name
$ assistant plugins install owner/repo --name my-plugin --force

# Shorthand: owner/repo works without the full URL
$ assistant plugins install owner/repo
```

The ref comes from the URL's `/tree/<ref>/` segment, or defaults to the repository's default branch. The install directory name is derived from the repo (or sub-path leaf) and can be overridden with `--name`.

A direct install **bypasses marketplace curation entirely**:

- The tree is materialized verbatim. No [postinstall adapter](#adapting-external-plugins) stub is overlaid, so a plugin authored for another ecosystem may install but contribute nothing on boot.
- The source is **untrusted**. It has not been reviewed, and its hooks and tools run inside the assistant with full access. The CLI prints a yellow warning naming the source so the choice to trust it is explicit.
- Unlike marketplace installs, which pin an immutable, reviewed commit SHA, a branch or `HEAD` ref is mutable. A direct install is a development convenience, not a reproducible pin. If you pin a full commit SHA in the URL, the integrity check still enforces it.
- The marketplace-only flags (`--ref`, `--pin`, `--allow-unreviewed`) do not apply to a direct install. The ref lives in the URL.

Once the plugin is ready for broader distribution, add it to `marketplace.json` so others can install it by name with a reviewed, reproducible pin.

### The plugins CLI

Six subcommands cover the lifecycle.

#### `plugins search`

**Signature:** `assistant plugins search <query>`

Search the catalog for plugin names matching `<query>` (a case-insensitive regex) and print each match with its source path.

- `--json`: Emit machine-readable JSON instead of a table.

#### `plugins install`

**Signature:** `assistant plugins install <name-or-url>`

Resolve `<name>` in the catalog, shallow-clone its repo at the pinned commit, and materialize it under `<workspaceDir>/plugins/<name>/`. The resolved commit is recorded for provenance. Or pass a GitHub URL (or `owner/repo` shorthand) to install directly from an untrusted source, bypassing the catalog. See "Installing from a GitHub URL (untrusted)" below.

- `--force`: Overwrite an existing install of the same name.
- `--ref <ref>`: Advanced. Read the catalog (and any adapter stub) from a different ref of the vellum-assistant repo; defaults to main. The external plugin itself is still fetched at the commit pinned in the manifest, never this ref. Marketplace installs only; for a GitHub URL, put the ref in the URL (`.../tree/<ref>/...`).
- `--pin <sha>`: Install a specific reviewed marketplace pin (full commit SHA). Run `plugins versions <name>` to list them. Marketplace installs only.
- `--allow-unreviewed`: With `--pin`, install a SHA that is not in the reviewed marketplace history. Marketplace installs only.
- `--name <name>`: Install directory name for a GitHub-URL install (default: derived from the repo or sub-path leaf). Ignored for marketplace installs.

Note: Installs are hot-loaded, and all surfaces should be picked up automatically.

#### `plugins list`

**Signature:** `assistant plugins list`

List the plugins installed under `<workspaceDir>/plugins/`, with each one's version and load status.

- `--json`: Emit machine-readable JSON instead of a table.

#### `plugins inspect`

**Signature:** `assistant plugins inspect <name>`

Show the installed copy's provenance (commit timestamp, hash, and location) alongside the marketplace's current pin, and classify whether an update is available. Also reports whether the on-disk files have local edits relative to the install-time fingerprint.

- `--json`: Emit machine-readable JSON instead of a summary.

#### `plugins upgrade`

**Signature:** `assistant plugins upgrade <name>`

Move an installed plugin to the marketplace's current pinned commit. It is a no-op when the install already matches the pin, and mechanically a forced re-install at the new commit (the old copy is kept until the fetch succeeds).

- `--dry-run`: Report the commit move without touching the install.
- `--json`: Emit machine-readable JSON instead of a summary.

Note: Upgrading re-installs at the new commit and overwrites any local edits to the plugin's source files. Preserved entries (`config.json`, `data/`, `.disabled`) are carried over to the new install, so user config and runtime data survive upgrades. The upgraded code is picked up immediately for each surface.

#### `plugins uninstall`

**Signature:** `assistant plugins uninstall <name>`

Remove `<workspaceDir>/plugins/<name>/`. Prompts for confirmation unless stdin is non-interactive. The entire plugin directory is removed, including `config.json` and `data/`, so no orphaned state is left behind.

- `--force`: Skip the confirmation prompt.

Note: The plugin is dropped immediately.

## Updating a plugin

Installs are pinned. Because the catalog pins each plugin to an immutable commit, an install never changes on its own. It stays on the commit it was installed at until you explicitly move it. Curators advance a plugin by bumping its `source.ref` in the manifest; your local copy only catches up when you upgrade it.

### Drift and local edits

Every install records its provenance (the resolved commit, the commit's timestamp, and a per-file fingerprint of the materialized tree) in an `install-meta.json` sidecar at the plugin root. The fingerprint excludes four preserved entries (`install-meta.json`, `config.json`, `data/`, `.disabled`) so user config edits and runtime data never show as drift. `assistant plugins inspect <name>` reads that sidecar, compares the installed commit against the marketplace's current pin, and reports one of six states:

- `up-to-date`: the installed commit matches the pin.
- `update-available`: the pin has moved past the installed commit.
- `not-installed`: nothing is installed under that name.
- `not-in-marketplace`: installed, but the catalog has no entry to compare against.
- `unknown-provenance`: installed without a recorded commit (an older or manually-copied install); reinstall to record one.
- `remote-unavailable`: the catalog could not be reached to resolve the pin.

Inspect leads with each side's commit **timestamp** as the human-readable version (the commit's committer date, so the installed and remote lines are directly comparable), with the commit hash shown as a secondary detail. It also recomputes the fingerprint against the on-disk files and reports **drift**: how many files were modified, added, or removed since install. This is a one-way signal that detects the working copy diverged, which matters because upgrading re-installs at the new commit and overwrites those edits.

```
# Check whether an install is behind the pin
$ assistant plugins inspect simple-memory
simple-memory
────────────────────────────────────────────
status      update available
installed
  timestamp 2026-06-01T12:34:56
  hash      ed09a4c
  location  /workspace/plugins/simple-memory
  updated   2026-06-01T12:35:10
drift       none
remote
  timestamp 2026-06-05T08:12:24
  hash      3eae182
  location  https://github.com/vellum-ai/simple-memory

# Preview the move, then upgrade to the current pin
$ assistant plugins upgrade simple-memory --dry-run
"simple-memory" would upgrade 2026-06-01T12:34:56 (ed09a4c) -> 2026-06-05T08:12:24 (3eae182)

dry run; no changes made.

$ assistant plugins upgrade simple-memory
Upgraded "simple-memory" 2026-06-01T12:34:56 (ed09a4c) -> 2026-06-05T08:12:24 (3eae182)

(12 files) -> /workspace/plugins/simple-memory
```

### Upgrading from the Plugins tab

The same drift check backs the in-product Plugins tab, so you do not have to drop to the CLI to stay current. When an installed plugin is behind the pin, its row shows an **Update available** badge and its detail page surfaces an **Upgrade** button that moves the install to the current pin and reloads the list.

If inspect reports local edits, the Upgrade button first asks you to confirm, since the upgrade will overwrite those changes. The button stays hidden whenever there is nothing to upgrade: an up-to-date install, a plugin not in the catalog, or an assistant too old to expose the drift check.

## The marketplace manifest

The manifest has a top-level `name`, an optional `owner`, and a `plugins` array. Each entry names the plugin and points at the exact source revision to install.

```json
{
  "name": "vellum-assistant",
  "owner": {
    "name": "Vellum",
    "url": "https://github.com/vellum-ai/vellum-assistant"
  },
  "plugins": [
    {
      "name": "example-plugin",
      "source": {
        "source": "github",
        "repo": "example-org/example-plugin",
        "ref": "e83c5163316f89bfbde7d9ab23ca2e25604af290"
      },
      "description": "Short summary shown in the catalog.",
      "category": "productivity",
      "homepage": "https://github.com/example-org/example-plugin",
      "license": "MIT"
    }
  ]
}
```

The fields each entry can set:

| Field           | Type       | Required | Description                                                                                                                    |
| --------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `name`          | `string`   | Required | The install name. `assistant plugins install <name>` resolves to this entry, and the name must be a single kebab-case segment. |
| `source.source` | `"github"` | Required | Source kind. Only github sources are resolved today.                                                                           |
| `source.repo`   | `string`   | Required | `owner/repo` of the external repository to fetch from.                                                                         |
| `source.ref`    | `string`   | Required | The full commit SHA (40 or 64 hex chars) to fetch. Tags and branches are rejected.                                             |
| `source.path`   | `string`   | Optional | Directory within the repo holding the plugin root. Omit for the repository root; `..` segments are rejected.                   |
| `description`   | `string`   | Optional | Short summary shown in the catalog.                                                                                            |
| `category`      | `string`   | Optional | Grouping label surfaced in the catalog.                                                                                        |
| `homepage`      | `string`   | Optional | Link to the plugin's home, surfaced in the catalog.                                                                            |
| `license`       | `string`   | Optional | Informational license identifier, surfaced where present.                                                                      |

## Why entries pin a commit

`source.ref` must be a full commit SHA. Tags and branches are rejected, because they are mutable: an upstream owner could retag or repoint them at different code, which the assistant would then clone and dynamically import. A full SHA pins the install to an immutable revision, so the reviewed manifest fully determines what executes.

To pin a release, resolve its tag to the underlying commit. Peel annotated tags with `^{}` so you record the commit, not the tag object:

```
# Resolve a release tag to its commit SHA
$ git ls-remote https://github.com/example-org/example-plugin 'refs/tags/v1.2.0^{}'
e83c5163316f89bfbde7d9ab23ca2e25604af290  refs/tags/v1.2.0^{}
```

## Adapting external plugins

Listing a plugin makes it install by name, but a plugin authored for another ecosystem may not match this loader's conventions and so contribute nothing on boot. A **postinstall adapter** bridges that gap: a small, curated transform committed alongside the marketplace entry that reshapes the cloned tree into Vellum's layout during install.
