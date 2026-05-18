# @vellum/design-library

Shared UI component library for Vellum web applications. Built with React and Tailwind CSS v4.

## Coding conventions

This package follows the same coding style as the web app. See
[`apps/web/STYLE_GUIDE.md`](../../apps/web/STYLE_GUIDE.md) for naming,
imports, formatting, and TypeScript conventions.

## Usage

Components are imported via the `exports` map:

```ts
import { Button } from "@vellum/design-library/components/button";
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
