# @vellum/design-library

Shared UI component library for Vellum web applications. Built with React and Tailwind CSS v4.

## Coding conventions

This package follows the same coding style as the web app. See
[`apps/web/STYLE_GUIDE.md`](../../apps/web/STYLE_GUIDE.md) for naming,
imports, formatting, and TypeScript conventions.

## Tailwind class naming

Tailwind scans source files as plain text — it cannot evaluate runtime
expressions. **Never construct class names with string interpolation.**

```ts
// BAD — Tailwind cannot detect these classes
className={`btn-${variant} size-${size}`}

// GOOD — static strings are always detectable
const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
};
className={VARIANT_CLASSES[variant]}
```

Choose the pattern that fits the component's complexity:

| Complexity | Pattern | When to use |
|---|---|---|
| Simple (1–2 variant axes) | `Record<Variant, string>` map | Button, Badge |
| Multi-axis variants | [`cva`](https://cva.style/docs) (class-variance-authority) | Tag, Alert |
| Conditional composition | `cn()` (clsx + tailwind-merge) | Any override/merge scenario |

All three keep class strings statically present in source so Tailwind's
scanner can detect them.

**Reference:** [Tailwind CSS — Detecting classes in source files](https://tailwindcss.com/docs/detecting-classes-in-source-files#dynamic-class-names)

## Usage

Import from the package root:

```ts
import { Button, Typography, cn } from "@vellum/design-library";
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
