# Plugin icon contract

This doc is the single cross-repo source of truth for **marketplace plugin icons** — the small glyph shown next to a plugin in `assistant plugins search`, the desktop/web catalog, and the marketing site. It mirrors how skill icons work. Two repos consume this contract and MUST enforce identical rules:

- **`vellum-ai/vellum-assistant`** (this repo) — the assistant validator at [`assistant/src/cli/lib/plugin-icon-file.ts`](../assistant/src/cli/lib/plugin-icon-file.ts) is the authoritative implementation. In-repo curation lives here (`plugins/marketplace.json`, `plugins/assets/`, `plugins/plugin-icons.json`).
- **`vellum-ai/vellum-assistant-platform`** — a Django validator behind `/v1/plugins/` that MUST match this doc byte-for-byte. Uploads the PNGs to GCS and serves the combined catalog `icon` value.

Any change to the format, limits, or manifest shape below is a **coordinated cross-repo change** — the TS validator and the Python validator move together, or a plugin that validates in one repo silently gets "no icon" in the other.

## PNG icon rules (author-bundled)

A plugin MAY ship a raster icon. The rules exist so third-party bytes served from a Vellum origin can never become a stored-XSS or path-traversal vector, and so a bad file degrades to "no icon" rather than an error.

- **PNG only.** No SVG. SVG is executable markup; serving attacker-authored SVG from a Vellum origin is a stored-XSS risk. A single well-known container (PNG magic + IHDR) also keeps the parser tiny and dependency-free.
- **Fixed filename, fixed location.** The file is always `icon.png` at the plugin root — `<source.path>/icon.png` for a plugin pinned to a repo subdirectory (`source.path`), or `icon.png` at the repo root when `source.path` is omitted. There is **no author-controlled path**, so there is no traversal surface.
- **Dimensions ≤ 128×128 px**, validated against the PNG IHDR width/height (not a trusted sidecar).
- **Size ≤ 32 KB.** The size gate runs before the bytes are read, so an oversized file never enters memory.
- **Fail-closed.** Any problem — missing file, wrong magic bytes, non-IHDR first chunk, oversized bytes, oversized dimensions, unreadable — resolves to "no icon". Validation **never throws**; callers surface "no icon" uniformly with no per-source error handling.

### `iconVersion`

`iconVersion` is the **first 16 hex chars of `sha256(bytes)`** of the validated `icon.png`. It is a stable content hash: identical bytes ⇒ identical version, any byte change ⇒ new version. It is the cache-bust token (see [Bucket convention](#bucket-convention)) and the value recorded in the manifest.

The authoritative constants — `MAX_ICON_BYTES = 32 * 1024`, `MAX_ICON_DIMENSION = 128`, the PNG magic signature, the IHDR checks, and the 16-hex `iconVersion` slice — all live in [`plugin-icon-file.ts`](../assistant/src/cli/lib/plugin-icon-file.ts). Treat that file as the spec; this doc explains it.

## The two in-repo sources

A plugin's icon can come from **either** a curated emoji **or** a vendored PNG. They are independent in-repo sources; the platform combines them into one catalog value (see [Platform combination](#platform-combination-and-precedence)).

### 1. Emoji — `icon` field on the marketplace entry

Each entry in [`plugins/marketplace.json`](../plugins/marketplace.json) MAY carry an optional `icon` string holding a single emoji. This is human-curated by whoever reviews the marketplace entry — the cheapest way to give a plugin a recognizable glyph with no asset pipeline.

```json
{
  "name": "caveman",
  "icon": "🪨",
  "source": { "source": "github", "repo": "JuliusBrussee/caveman", "ref": "<full-commit-sha>" }
}
```

The marketplace entry schema (name, `source.{repo,ref,path}` with `ref` pinned to a **full commit SHA**, description, category, homepage, license, and the optional `icon`) is defined in [`plugin-marketplace.ts`](../assistant/src/cli/lib/plugin-marketplace.ts). The `icon` field is curated in-repo, not fetched from the third-party plugin. It is wired end to end: `marketplaceEntrySchema` carries it through `marketplaceMatch` into the catalog projection and the `assistant plugins search` response, and the platform's `/v1/plugins/` reads the same curated emoji independently to render the marketing site.

### 2. PNG — vendored asset + derived manifest

An author-bundled `icon.png` (validated per the rules above) is **vendored into this repo** rather than served from the third-party source, so the bytes we serve are the exact bytes we reviewed:

- **Asset:** `plugins/assets/<name>/icon.png` — the validated icon for marketplace plugin `<name>`.
- **Manifest:** `plugins/plugin-icons.json` — a derived index. **An entry is present if and only if a valid vendored icon exists** for that plugin.

```json
{
  "version": 1,
  "plugins": {
    "<name>": { "iconVersion": "<16hex>" }
  }
}
```

Both the vendored asset and the manifest are generated, not hand-edited (see [Adding or updating a plugin icon](#adding-or-updating-a-plugin-icon)).

## Platform combination and precedence

The platform serves each plugin a single `icon` value in `/v1/plugins/`, matching how skills expose one `icon`. It is a **URL-or-emoji** value resolved by this precedence:

1. **PNG URL** — if `plugins/plugin-icons.json` has an entry for the plugin, the platform serves the GCS URL of the vendored `icon.png` (cache-busted by `iconVersion`; see below).
2. **Emoji** — else if the marketplace entry has an `icon` emoji, serve that string.
3. **`null`** — else no icon. The client then falls back to a generic 📦/🧩 glyph (per [PR #37087](https://github.com/vellum-ai/vellum-assistant/pull/37087)).

A vendored PNG always wins over a curated emoji for the same plugin.

## Bucket convention

Vendored PNGs are uploaded to GCS and served publicly, mirroring the skill asset convention (`gs://<GCS_SKILL_ASSETS_BUCKET>/<id>/assets/icon.svg`, uploaded by [`.github/workflows/upload-skill-assets.yaml`](../.github/workflows/upload-skill-assets.yaml)).

- **Object path:** `gs://<GCS_PLUGIN_ASSETS_BUCKET>/<name>/icon.png`.
- **Serving:** public, long-lived cache (`Cache-Control: public, max-age=…`, matching the skill bucket's `max-age=86400`).
- **Cache-busting:** because the object path is stable but the bytes can change, consumers request `…/<name>/icon.png?v=<iconVersion>`. A content change produces a new `iconVersion`, so the query string changes and caches miss exactly when they should.

## Adding or updating a plugin icon

**Emoji:**

1. Set (or change) the `icon` string on the plugin's entry in `plugins/marketplace.json`.
2. Run `sync-bundled-copies` (`meta/sync-bundled-copies.ts`) so the bundled offline copy at `assistant/src/cli/lib/bundled-marketplace.json` stays in sync.
3. Commit both files.

**PNG:**

1. Run the generator `scripts/plugins/generate-plugin-icons.mjs` (added later in the plugin-icons plan). It fetches the plugin's `icon.png`, validates it against the rules above, vendors the valid bytes to `plugins/assets/<name>/icon.png`, and regenerates `plugins/plugin-icons.json`.
2. Commit the vendored asset **and** the regenerated `plugins/plugin-icons.json` together. A plugin whose icon fails validation simply gets no manifest entry (and falls back to emoji or the generic glyph).
