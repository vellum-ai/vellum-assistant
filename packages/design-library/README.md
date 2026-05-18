# @vellum/design-library

Shared UI component library for Vellum web applications. Built with React 19 and Tailwind CSS v4.

## Component authoring conventions

### React 19 ref-as-prop (no `forwardRef`)

React 19 passes `ref` as a regular prop. Do **not** use `forwardRef` — it is
deprecated.

```tsx
// ✅ Correct — React 19 ref-as-prop
export function Tag({ ref, className, ...rest }: TagProps) {
  return <span ref={ref} {...rest} />;
}

// ❌ Wrong — legacy forwardRef pattern
export const Tag = forwardRef<HTMLSpanElement, TagProps>(function Tag(props, ref) {
  return <span ref={ref} {...props} />;
});
```

For element props including ref, use `ComponentProps<"element">` (which
includes `ref` in React 19) instead of `HTMLAttributes<HTMLElement>` (which
does not).

References:
- [React 19 — ref as a prop](https://react.dev/blog/2024/12/05/react-19#ref-as-a-prop)
- [React — Manipulating the DOM with Refs](https://react.dev/learn/manipulating-the-dom-with-refs)

### `data-slot` attribute

Every component's root element must include `data-slot="component-name"`.
Multi-part components add a slot to each part (`data-slot="card"`,
`data-slot="card-header"`, etc.). This enables CSS-only style overrides
without touching component source — the consuming app can target
`[data-slot="tag"]` from its own stylesheet.

References:
- [shadcn/ui v4 — data-slot pattern](https://ui.shadcn.com/docs/changelog/2025-03-data-slot)
- [Tailwind CSS — Styling based on data attributes](https://tailwindcss.com/docs/hover-focus-and-other-states#data-attributes)

### Function declarations

Use function declarations (not `const` + arrow) for components. This keeps
names visible in stack traces and React DevTools.

```tsx
export function Tag({ ... }: TagProps) { /* ... */ }
```

### Props interface naming

Props interfaces use `{Component}Props`:

```tsx
export interface TagProps extends ComponentProps<"span"> { /* ... */ }
```

### Export variant functions

When a component uses CVA, export the variants function so consumers can
compose variant classes without rendering the component:

```tsx
export { Tag, tagVariants };
```

## Tailwind class patterns

Tailwind scans source files as plain text — it cannot evaluate runtime
expressions. **Never construct class names with string interpolation.**

```ts
// ❌ BAD — Tailwind cannot detect these classes
className={`btn-${variant} size-${size}`}

// ✅ GOOD — static strings are always detectable
const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
};
className={VARIANT_CLASSES[variant]}
```

Choose the pattern that fits the component's complexity:

| Pattern | When to use | Examples |
|---|---|---|
| `Record<Variant, string>` map | Simple lookups — 1–2 axes with short class strings | Button, Typography |
| [`cva`](https://cva.style/docs) (class-variance-authority) | Long base classes, `VariantProps` type extraction, `defaultVariants`, compound variants | Tag, Badge, Alert |
| `cn()` (clsx + tailwind-merge) | Boolean toggles, className overrides, merge scenarios | Card, any component with `className` prop |

**`cva` is for declarative variant definitions** — it provides type-safe
`VariantProps`, `defaultVariants`, and compound variant support. **`Record`
maps are simpler** — use them when you just need a lookup table. **`cn()` is
always used for className merging** — it pairs with both CVA and Record
patterns.

References:
- [Tailwind CSS — Detecting classes in source files](https://tailwindcss.com/docs/detecting-classes-in-source-files#dynamic-class-names)
- [CVA docs](https://cva.style/docs)

## File organization

Components live as **single flat files** in `src/components/`. This matches
the [shadcn/ui convention](https://ui.shadcn.com/docs) — even multi-part
components (Card with CardHeader, CardBody, etc.) are in a single file.

Break a component into its own directory only when it has:
- 300+ lines **and** multiple independently useful subcomponents
- Colocated tests or component-specific utilities

Variants, types, and helper constants stay in the component file — they are
tightly coupled to the component's rendering logic.

## Usage

Import from the package root:

```ts
import { Button, Typography, Tag, tagVariants, cn } from "@vellum/design-library";
```

Subpath imports are also available for targeted imports:

```ts
import { Button } from "@vellum/design-library/components/button";
import { cn } from "@vellum/design-library/utils/cn";
```

The consuming app must include this package's source in its Tailwind source
scan so that utility classes used here are generated:

```css
@source "../node_modules/@vellum/design-library/src";
```

## Peer dependencies

- `react >= 19`
- `react-dom >= 19`
- `tailwindcss >= 4`
