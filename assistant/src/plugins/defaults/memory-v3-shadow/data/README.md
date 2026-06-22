# memory-v3 data artifacts

This directory ships a **generic, synthetic stub** data set for memory-v3's
topic-tree routing. It exists so the v3 loaders have something valid to read out
of the box. It is **example-only**: the names, paths, and bodies here are
neutral placeholders (`domain-a`, `topic-x`, `page-a`, …) with no real content.

## Workspace override

A maintainer's real per-instance content does **not** live in this repo. At
runtime the loaders prefer a workspace override directory over this bundled
default:

```
<workspace>/memory/v3/data/   ← preferred when present (real content)
assistant/src/memory/v3/data/ ← this bundled stub (fallback)
```

If `<workspace>/memory/v3/data/` exists, the loaders read the leaf tree,
assignments, and core list from there instead of from this directory. Otherwise
they fall back to the stub shipped here.

## File shapes

### `leaves/**/*.md`

Each leaf is a Markdown file whose path under `leaves/` mirrors its taxonomy
path: `leaves/domain-a/topic-x.md` is the leaf `domain-a/topic-x`. Every file
has YAML frontmatter followed by a label body.

```markdown
---
path: domain-a/topic-x
in_core: true
---

A recall-complete description (~100–300 words in real content) enumerating the
entities, events, and register cues that route a turn to this leaf.
```

Frontmatter fields:

| Field     | Type      | Meaning                                                                   |
| --------- | --------- | ------------------------------------------------------------------------- |
| `path`    | `string`  | The leaf's taxonomy path. Must match the file's location under `leaves/`. |
| `in_core` | `boolean` | Whether this leaf is always loaded into context (see `core.json`).        |

The body is the routing label — the prose used to decide whether a turn should
route to this leaf.

### `assignments.json`

Maps each example slug to the list of leaf paths it belongs to. A slug may be
multi-homed (assigned to more than one leaf). Every referenced leaf path **must**
have a corresponding `.md` file under `leaves/`.

```json
{
  "page-a": ["domain-a/topic-x"],
  "page-b": ["domain-a/topic-x", "domain-a/topic-y"],
  "page-c": ["domain-b/topic-z"]
}
```

Shape: `Record<string /* slug */, string[] /* leaf paths */>`.

### `core.json`

The always-on core list — leaves that are loaded for every turn regardless of
routing. Each entry **must** reference a leaf whose `.md` frontmatter has
`in_core: true`.

```json
{ "alwaysOn": ["domain-a/topic-x"] }
```

Shape: `{ "alwaysOn": string[] /* leaf paths */ }`.

## Consistency invariants

- Every leaf path in `assignments.json` has a matching `.md` file under `leaves/`.
- Every leaf path in `core.json`'s `alwaysOn` has `in_core: true` in its `.md`
  frontmatter, and vice versa (an `in_core: true` leaf appears in `alwaysOn`).
- A leaf file's `path` frontmatter matches its location under `leaves/`.
