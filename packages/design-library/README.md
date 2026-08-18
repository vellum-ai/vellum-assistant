# @vellumai/design-library

Shared UI component library for Vellum web applications. Built with React 19 and Tailwind CSS v4.

## Component authoring conventions

The rules live in [`AGENTS.md`](./AGENTS.md) beside this file: ref-as-prop
(no `forwardRef`), `data-slot` on every root, function declarations, exported
CVA variant functions, named exports only, single-file components,
`{Component}Props` naming, and customization through props rather than
wrappers. That file also carries the Storybook story rules and the PR review
checklist.

`AGENTS.md` is the single owner of these rules. Add a rule there, not here.

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

Components are single flat files in `src/components/`. See
[`AGENTS.md`](./AGENTS.md) for when a component earns its own directory.

## Usage

Import from the package root:

```ts
import { Button, Typography, Tag, tagVariants, cn } from "@vellumai/design-library";
```

Subpath imports are also available for targeted imports:

```ts
import { Button } from "@vellumai/design-library/components/button";
import { cn } from "@vellumai/design-library/utils/cn";
```

### Just-in-Time compilation

This package uses the **Just-in-Time (JIT) internal package** strategy —
it exports raw TypeScript source that the consuming app's bundler (Vite)
compiles on the fly. This means:

- **No build step required** — clone, `bun install`, and start developing.
  Changes to design library components are picked up immediately by HMR.
- **Consumer apps must list this package's dependencies** in their own
  `package.json` (e.g. `react-markdown`, `remark-gfm`, Radix packages).
  Because the `file:` link resolves to raw source, TypeScript resolves
  imports through the consumer's `node_modules`. These deps are deduplicated
  at runtime by Vite — they only need to be listed for type resolution.

For multi-consumer setups or when build times become a concern, consider
the [compiled package strategy](https://turborepo.dev/docs/core-concepts/internal-packages#compiled-packages)
instead.

References:
- [Turborepo — Internal Packages: Just-in-Time strategy](https://turborepo.dev/docs/core-concepts/internal-packages#just-in-time-packages)
- [Hiroki Osame — Think twice before importing package source files](https://hirok.io/posts/importing-source-files-in-dev) (tradeoffs of source imports)

### Tailwind and token setup

The consuming app must import the design token stylesheet and include this
package's source in its Tailwind source scan:

```css
/* In your app's global CSS (e.g. globals.css) */
@import "@vellumai/design-library/tokens.css";
@source "../node_modules/@vellumai/design-library/src";
```

The token stylesheet provides:

- **CSS custom properties** for all three themes (light, dark, velvet)
- **`@custom-variant dark`** wired to `data-theme="dark"` — enables `dark:`
  utility prefixes ([Tailwind v4 docs](https://tailwindcss.com/docs/dark-mode#using-a-data-attribute))
- **`@theme` bridge** registering `--background`, `--foreground`, and
  `--font-sans` as Tailwind theme variables — generates `bg-background`,
  `text-foreground`, etc. ([Tailwind v4 docs](https://tailwindcss.com/docs/theme))
- **`@utility` classes** for typography and button variants

Theme selection is controlled by a `data-theme` attribute on an ancestor element:

```html
<html data-theme="dark">  <!-- "light" | "dark" | "velvet" -->
```

## Adding design tokens

Tokens are defined in [`src/tokens.css`](./src/tokens.css). The file has three
layers that work together — follow this checklist when adding or modifying tokens:

1. **Add the CSS variable** in each theme block (`:root` / `[data-theme="light"]`,
   `[data-theme="dark"]`, `[data-theme="velvet"]`). All three themes must define
   every variable so no token falls through to an unintended default.

2. **Bridge to Tailwind (if needed)** — if the new token should generate a
   standard Tailwind utility class (e.g. `bg-*`, `text-*`, `border-*`), add a
   corresponding entry in the `@theme inline { }` block at the top of the file.
   Use the [Tailwind v4 theme variable namespaces](https://tailwindcss.com/docs/theme#theme-variable-namespaces)
   to pick the right prefix (`--color-*`, `--spacing-*`, etc.).
   Semantic tokens that are only referenced via `var()` in `@utility` classes or
   component styles do **not** need a `@theme` entry.

3. **Add `@utility` classes (if needed)** — composite utilities that combine
   multiple CSS properties (like the `text-title-large` typography classes)
   should be registered with `@utility` at the bottom of the file.

**Tokens not yet migrated from the platform repo:**
The platform's `globals.css` includes additional token categories (spacing scale,
border-radius scale, shadows, color ramps like Moss/Stone/Forest/Amber) that
have not been brought into the design library yet. These should be added
incrementally as components that need them are migrated. When adding them, follow
the same three-step pattern above and keep values in sync with the platform's
[`appTheme.css`](https://github.com/vellum-ai/vellum-assistant-platform/blob/main/web/src/app/(app)/appTheme.css)
and [`globals.css`](https://github.com/vellum-ai/vellum-assistant-platform/blob/main/web/src/app/globals.css).

## Customization

Components expose callback or component props for injecting
domain-specific behavior. The library provides sensible defaults;
consumers override only what they need.

```tsx
import { MarkdownMessage } from "@vellumai/design-library";

// Default behavior — links open in a new tab with noopener noreferrer
<MarkdownMessage content={text} />

// Custom link rendering — pass a component via the linkComponent prop
<MarkdownMessage content={text} linkComponent={MyCustomLink} />
```

This is the standard composition pattern used by
[react-markdown](https://github.com/remarkjs/react-markdown#components)
(`components` prop),
[MUI](https://mui.com/material-ui/integrations/routing/) (`component`
prop), and [Radix](https://www.radix-ui.com/docs/primitives/guides/composition)
(`asChild`).

References:
- [React — Passing Props to a Component](https://react.dev/learn/passing-props-to-a-component)

## Storybook

[Storybook](https://storybook.js.org/) provides isolated component development and auto-generated documentation.

```bash
cd packages/design-library
bun install                # installs deps + Playwright Chromium via @playwright/browser-chromium
bun run storybook          # dev server → http://localhost:6006
bun run build-storybook    # static build → storybook-static/
```

Stories are colocated next to their components (`*.stories.tsx`). Autodocs generates prop tables from TypeScript types automatically.

Use the **Theme** toolbar in Storybook to switch between Light, Dark, and Velvet modes. All components re-render with the selected theme's tokens.

### Testing

Every story doubles as a render test via the [Vitest addon](https://storybook.js.org/docs/writing-tests/integrations/vitest-addon):

```bash
cd packages/design-library
bun run test               # run all render tests (Playwright Chromium)
```

Tests run in a real browser (headless Chromium via [Playwright](https://playwright.dev/)) and verify that each story renders without errors. No extra test files needed — stories _are_ the tests.

Playwright Chromium is installed automatically by the [`@playwright/browser-chromium`](https://www.npmjs.com/package/@playwright/browser-chromium) package (listed in `trustedDependencies` so bun runs its install script). The Storybook dev server also uses Playwright to power the in-UI testing widget — if you see a "Failed to initialize Vitest" error on startup, run `bunx playwright install chromium` to fix it.

### MCP (AI agent integration)

The [`@storybook/addon-mcp`](https://github.com/storybookjs/mcp) addon exposes component metadata (props, stories, variants) via the [Model Context Protocol](https://modelcontextprotocol.io/). AI coding agents (Claude, Cursor, Copilot, etc.) can discover and correctly use design library components when this Storybook is running.

### npm publishing

The `"files"` field in `package.json` allowlists `src/` for the npm tarball, which excludes `.storybook/` config and `storybook-static/` build output ([npm docs](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#files)). Colocated `*.stories.tsx` files under `src/` are included in the tarball but are harmless to consumers — this matches the convention used by most design system packages. To exclude stories from the tarball for size optimization, add an `.npmignore` with `**/*.stories.tsx`.

## Peer dependencies

- `react >= 19`
- `react-dom >= 19`
- `tailwindcss >= 4`
