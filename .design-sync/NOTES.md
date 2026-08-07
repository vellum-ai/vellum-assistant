# design-sync notes — @vellumai/design-library

Repo-specific gotchas for syncing `packages/design-library` to claude.ai/design.
Read this before touching anything; every bullet cost a debugging cycle.

## Build inputs this package does not produce on its own

`.design-sync/prepare-build.sh` (wired as `cfg.buildCmd`) regenerates both. It
requires `.design-sync/sb-reference` to exist first, so on a fresh clone the
order is: storybook reference build → `prepare-build.sh` → converter.

- **[GENERAL] No `.d.ts` tree → 0 components discovered.** The package ships raw
  TypeScript (`exports["."]` → `./src/index.ts`) and has no build script, so
  component discovery (`exportedNames`, which reads PascalCase *value* exports
  out of the declaration tree) found nothing and every storybook title landed in
  `[TITLE_UNMAPPED]`. Fix: `prepare-build.sh` runs `tsc --emitDeclarationOnly`
  into `packages/design-library/dist/`.
- **[GENERAL] The converter looks for the types entry at `<pkg>/index.d.ts`.**
  Even with `dist/` populated, `findTypesRoot` resolved the *root* correctly but
  `projectFor` still computed the entry as `<pkg>/index.d.ts` (absent) and
  returned an empty export set. Fix: `publishConfig.types = "dist/index.d.ts"`
  in `packages/design-library/package.json`. `publishConfig` is inert for a
  `private: true` package that is never published, and the converter only honors
  it when the file exists on disk — so it changes nothing for consumers.
- **[GENERAL] Component CSS is Tailwind v4 and exists only after compilation.**
  The package ships no compiled stylesheet, so previews rendered as *completely
  unstyled native controls* while storybook looked correct. The compiled output
  lives in the reference storybook build; `prepare-build.sh` stages
  `sb-reference/assets/iframe-*.css` to `dist/ds-styles.css` and points
  `cfg.cssEntry` at it. `cssEntry` is **appended** to `_ds_bundle.css`, so the
  KaTeX rules already there survive alongside it.
- **[GENERAL] Brand fonts ride along with that stylesheet.** DM Sans, DM Mono
  and Instrument Serif are referenced by relative `url()` from the compiled CSS.
  Font url()s resolve relative to the `cssEntry`'s own directory (bounded to the
  package dir), so `prepare-build.sh` copies the storybook's font assets into
  `dist/` beside `ds-styles.css`. Without this the DS pane renders in system
  fonts and the compare oracle **cannot see it** — both panels fall back
  identically. If `[FONT_MISSING]` ever names DMSans/DMMono/InstrumentSerif,
  this copy step broke.

## Known-and-accepted warnings

- **`! preview decorator bundle failed: Could not resolve "tailwindcss"`** —
  expected and harmless. `.storybook/preview.tsx` imports `preview.css`, which
  starts with `@import "tailwindcss"`; esbuild can't resolve that bare specifier.
  The only thing those decorators supply is `withThemeByDataAttribute`, which
  sets `data-theme` on the html element. `src/tokens.css` declares the light
  palette on `:root, [data-theme="light"]`, so previews get the correct light
  theme with no wrapper at all. Verified against storybook in the solo phase.
  **Do not set `cfg.provider`** — there is no React theme provider in this DS to
  point it at; theming is an ancestor attribute, documented in `conventions.md`.
- **`[REFERENCE_STALE?]`** fires whenever the bundle is rebuilt without
  rebuilding `sb-reference`. It only matters if the *DS source* changed. Config
  and converter-only changes leave the reference valid.
- **`[STORY_CAP]`** — Button (15 stories), Select (17), Notice (10),
  MarkdownMessage (9) capture only their first 6. Raise with `--max-stories` if
  the tail variants need individual verification.

## Converter gap — must be re-applied after every re-stage

**`.ds-sync/lib/bundle.mjs` needs `.ttf`/`.eot` entries in its esbuild loader
map.** `markdown-message.tsx` side-effect-imports `katex/dist/katex.min.css`,
whose `@font-face` blocks reference `.ttf`. `sharedBuildOptions` only declares
`.svg/.png/.woff/.woff2`, so the **main bundle build hard-fails** with
`No loader is configured for ".ttf" files` (20 errors). The story-compile path
already handles this — `lib/story-imports.mjs`'s `STORY_LOADERS` has
`'.ttf': 'dataurl', '.eot': 'empty'` — the two maps have simply drifted.

Patch applied (in `sharedBuildOptions`, alongside the existing entries):

```js
'.ttf': 'dataurl',
'.eot': 'empty',
```

`.ds-sync/` is gitignored and re-copied from the skill on every re-sync, so
**this patch is lost each time and must be re-applied**. `bundle.mjs` is
app-contract surface the skill forbids forking into
`.design-sync/overrides/`, so there is no committed home for it. Upstream fix:
add `.ttf`/`.eot` to `sharedBuildOptions`'s loader map so it matches
`STORY_LOADERS`.

Symptom if forgotten: `package-build.mjs` exits 1 with a wall of
`No loader is configured for ".ttf"` errors before anything is emitted.

## Card presentation

`cfg.overrides` carries only presentation keys, all derived from
`[GRID_OVERFLOW]` warnings in `package-validate.mjs`:

- `cardMode: "column"` — Collapsible, Input, MarkdownMessage, SegmentControl,
  Select, StatSquare, Tabs, VirtualList (stories render wider than a grid cell).
- `cardMode: "single"` + `primaryStory: "Default"` — Tooltip (portal content
  positions outside any cell).
- `titleMap: {"Toast": "Toaster"}` — the storybook title is `Toast` but the
  package exports the component as `Toaster` (`toast` is the imperative fn).

## Re-sync risks

- **The `.ttf` loader patch above is the single most likely cause of a failed
  re-sync.** It is the first thing to check if the build dies immediately.
- **`prepare-build.sh` depends on the storybook asset filename shape**
  (`iframe-*.css`). Storybook/Vite chunking changes could rename or split it;
  the script fails loudly rather than silently shipping unstyled CSS. If it ever
  matches more than one file the `cat` still concatenates them, which is fine.
- **The staged stylesheet is a snapshot of the reference storybook build.** If
  the DS source changes and `sb-reference` is *not* rebuilt before
  `prepare-build.sh`, the shipped CSS silently describes the old design. Rebuild
  both together, always.
- **`dist/` is gitignored**, so a fresh clone has neither the `.d.ts` tree nor
  the stylesheet until `prepare-build.sh` runs. The converter's failure mode
  when it hasn't is "0 components", not an error.
- **Theming is verified for light only.** `dark` and `velvet` are real themes in
  `tokens.css` gated on `data-theme`; nothing in the sync exercises them.
- **Story caps** mean Button/Select/Notice/MarkdownMessage tail stories were
  never individually graded (see `[STORY_CAP]` above).
- **`markdown-message.stories.tsx` references `https://example.com/...` images**
  deliberately (testing the missing-image fallback). These are fixtures, not a
  real remote-asset dependency, so `[ASSETS_BLOCKED]` is not a concern here.
