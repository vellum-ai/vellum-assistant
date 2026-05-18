# Design Library — Agent Instructions

Applies to all code under `packages/design-library/`. Subordinate to root [`AGENTS.md`](../../AGENTS.md).

## Component rules

1. **No `forwardRef`.** React 19 passes ref as a regular prop. Use `ComponentProps<"element">` for props that include ref.
   - Reference: [React 19 — ref as a prop](https://react.dev/blog/2024/12/05/react-19#ref-as-a-prop)

2. **`data-slot` on every root element.** Multi-part components add a slot per part (e.g. `data-slot="card"`, `data-slot="card-header"`).
   - Reference: [shadcn/ui v4 — data-slot](https://ui.shadcn.com/docs/changelog/2025-03-data-slot)

3. **Function declarations** for components (not arrow expressions or `const` assignments).

4. **Export variant functions** alongside components when using CVA (e.g. `export { Tag, tagVariants }`).

5. **No default exports.** Named exports only.

6. **Single-file components.** Keep variants, types, and helpers in the component file unless it exceeds 300 lines with multiple independently useful subcomponents.

## Review checklist

When reviewing PRs that add or modify design library components, verify:

- [ ] No `forwardRef` usage — ref is destructured from props
- [ ] `data-slot` attribute on every component root element
- [ ] `ComponentProps<"element">` used instead of `HTMLAttributes<HTMLElement>` (to include ref)
- [ ] Component uses function declaration, not `const` + arrow
- [ ] CVA-based components export their variants function
- [ ] No string interpolation for Tailwind classes
- [ ] `.js` extension on all relative imports (NodeNext resolution)

## Commands

```bash
cd packages/design-library && bun run typecheck   # Type-check
```

## Dependencies

- Use `bun add --exact` for all dependencies (enforced by root bunfig.toml).
- Peer dependencies use `>=` ranges.
- All deps must have MIT-compatible licenses.
