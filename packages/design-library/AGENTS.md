# Design Library — Agent Instructions

Applies to all code under `packages/design-library/`. Subordinate to root [`AGENTS.md`](../../AGENTS.md).

## Component rules

1. **No `forwardRef`.** `forwardRef` is deprecated in React 19 — ref is now a
   regular prop. Prefer `ComponentProps<"element">` over
   `HTMLAttributes<HTMLElement>` because it includes element-specific props
   (`href` for `<a>`, `type` for `<button>`, etc.) alongside ref. Exception:
   polymorphic components that accept an `as` prop may use
   `HTMLAttributes<HTMLElement>` + explicit `ref?: Ref<HTMLElement>` since
   the element type is not fixed.
   - Reference: [React 19 — ref as a prop](https://react.dev/blog/2024/12/05/react-19#ref-as-a-prop)

2. **`data-slot` on every root element.** Consumers can style components from
   CSS without modifying the component source — e.g. `[data-slot="tag"] { ... }`.
   Multi-part components add a slot per part (`data-slot="card"`,
   `data-slot="card-header"`, etc.). This is the pattern shadcn/ui v4 adopted
   for Tailwind v4 compatibility, where CSS-only overrides replace the old
   `className` merging approach.
   - Reference: [shadcn/ui v4 — data-slot](https://ui.shadcn.com/docs/changelog/2025-03-data-slot)

3. **Function declarations** for components (not arrow expressions or `const`
   assignments). Function declarations are hoisted and keep component names
   visible in stack traces and React DevTools, making debugging easier.

4. **Export variant functions** alongside components when using CVA (e.g.
   `export { Tag, tagVariants }`). This lets consumers compose variant classes
   in contexts where they don't render the component directly — e.g. applying
   Tag's tone styles to a non-Tag element.

5. **No default exports.** Named exports only. Default exports allow silent
   renames at import sites, which breaks refactoring and grep-ability.

6. **Single-file components.** Variants, types, and helpers are tightly coupled
   to the component's rendering logic — splitting them across files adds
   indirection without benefit. This matches the shadcn/ui convention where
   even multi-part components (Card with CardHeader, CardBody, etc.) live in a
   single file. Only break into a directory when the file exceeds 300 lines
   with multiple independently useful subcomponents.

7. **Customization via props, not wrappers.** When a component needs
   domain-specific behavior (e.g. custom link rendering), expose a callback
   or component prop with a sensible default. Consumers inject behavior at
   the call site. This follows the patterns used by
   [react-markdown](https://github.com/remarkjs/react-markdown#components)
   (`components` prop),
   [MUI](https://mui.com/material-ui/integrations/routing/) (`component`
   prop), and [Radix](https://www.radix-ui.com/docs/primitives/guides/composition)
   (`asChild`). Domain convenience wrappers are the app layer's
   responsibility — not the design library's.

## Review checklist

When reviewing PRs that add or modify design library components, verify:

- [ ] No `forwardRef` usage — ref is destructured from props
- [ ] `data-slot` attribute on every component root element
- [ ] `ComponentProps<"element">` used instead of `HTMLAttributes<HTMLElement>` (for element-specific props + ref) — exception: polymorphic `as` components
- [ ] Component uses function declaration, not `const` + arrow
- [ ] CVA-based components export their variants function
- [ ] No string interpolation for Tailwind classes
- [ ] No `.js` extensions on relative imports (Bundler resolution)

## Commands

```bash
cd packages/design-library && bun run typecheck   # Type-check
```

## Dependencies

- Use `bun add --exact` for all dependencies (enforced by root bunfig.toml).
- Peer dependencies use `>=` ranges.
- All deps must have MIT-compatible licenses.
