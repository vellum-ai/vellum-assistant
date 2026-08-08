## Building with this design system

Vellum's component library. Tailwind v4 over a semantic CSS-variable token
layer, shared with the Swift macOS client so the two stay visually in sync.

### Setup — no provider needed

Components read their colors from CSS variables, so they are styled as soon as
`styles.css` is loaded. There is **no theme provider component**: theming is an
ancestor attribute.

```jsx
<div data-theme="light">   {/* "light" (default) | "dark" | "velvet" */}
  <Button variant="primary">Save</Button>
</div>
```

`:root` already carries the light palette, so omitting `data-theme` gives you
light mode. Set it on `<html>` or any ancestor to switch. `Tooltip` embeds its
own provider and works standalone; wrap a subtree in `TooltipProvider` only to
change global delay behaviour.

### Read this before you style anything

**The stylesheet is a compiled, tree-shaken snapshot — not a live Tailwind
build.** It contains only the utility classes this library's own components
already use. `gap-2` and `p-4` exist; `gap-7` and `p-10` do not. Arbitrary
values are baked per-usage too: `bg-[var(--surface-lift)]` exists because a
component uses it, but a new one you invent will not be generated and your
element renders unstyled.

So, for **your own** layout and glue, style with inline `style` and CSS
variables. The variables are declared on `:root`, so this always resolves:

```jsx
<div style={{
  background: "var(--surface-lift)",
  border: "1px solid var(--border-element)",
  color: "var(--content-secondary)",
  borderRadius: 12,
  padding: 16,
  gap: 8,
}}>
```

Use the library's components for anything they cover, and inline styles for the
surrounding layout. Never hardcode a hex color — always a `var(--token)`, so
light/dark/velvet all track automatically.

### The token vocabulary

Semantic colors (all defined per theme, all safe in inline styles):

| Family | Tokens |
|---|---|
| `--surface-*` | `base` `overlay` `active` `lift` `hover` `sunken` |
| `--primary-*` | `base` `hover` `active` `disabled` `second-hover` |
| `--border-*` | `base` `element` `hover` `active` `subtle` `overlay` `disabled` |
| `--content-*` | `emphasised` `default` `strong` `secondary` `tertiary` `quiet` `faint` `disabled` `inset` `link` |
| `--system-*` | `positive-strong` `positive-weak` `positive-on-weak` `negative-strong` `negative-hover` `negative-weak` `negative-on-weak` `info-strong` `info-weak` `mid-strong` `mid-weak` |

Raw palette ramps are also declared in full — `--color-<ramp>-<step>` for
`moss`, `stone`, `forest`, `emerald`, `danger`, `amber`, each `50`–`950`
(e.g. `var(--color-stone-100)`). Prefer the semantic tokens; these are the
escape hatch.

Note: `--radius-*`, `--shadow-*`, `--app-spacing-*` and `--anim-*` are
documented in the source but are **tree-shaken out** of the shipped stylesheet.
Use plain numbers for radius/spacing and the `shadow-sm|md|lg|xl` classes.

**Typography is registered utility classes** — use these rather than
`text-sm`/`font-bold`. All thirteen ship:

`text-title-large` `text-title-medium` `text-title-small`
`text-body-large-default` `text-body-large-lighter`
`text-body-medium-default` `text-body-medium-lighter`
`text-body-small-default` `text-body-small-lighter` `text-body-small-emphasised`
`text-label-medium-default` `text-label-small-default` `text-chat`

Or the `Typography` component's `variant` prop, which wraps the same scale.

Three brand faces ship with the bundle. Body text is already DM Sans, and the
`font-mono` class gives you DM Mono. Instrument Serif has no utility class —
reach it with an explicit stack when you want display copy:
`style={{ fontFamily: '"Instrument Serif", serif' }}`.

Custom variants beyond Tailwind's defaults: `dark:` (tracks `data-theme`, and
also applies under velvet), `keyboard-focus:` (focus ring for keyboard users
only, not pointer), `touch-mobile:`.

`cn()` is exported for merging class names.

### Where the truth lives

These are authoritative in a way this summary is not:

- `styles.css` and the stylesheets it imports — every token value per theme, and
  the exact set of utility classes that actually exist.
- `components/<Group>/<Name>/<Name>.d.ts` — the real prop contract.
- `components/<Group>/<Name>/<Name>.prompt.md` — per-component usage notes.

### A worked example

```jsx
<Card variant="bordered" padding="md">
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
    <span className="text-body-medium-default">Weekly digest</span>
    <Tag tone="positive">Active</Tag>
  </div>
  <p className="text-body-small-lighter" style={{ marginTop: 4 }}>
    Sent every Monday at 9am.
  </p>
  <Button variant="primary" size="sm">Manage</Button>
</Card>
```
