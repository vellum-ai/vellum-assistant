---
name: testing-safe-area-css
description: Runtime-test iOS safe-area-inset / mobile layout CSS changes in clients/web via Storybook. Use when verifying notch/Dynamic Island spacing, header/banner padding, or any change gated on --safe-area-inset-top, since real insets are 0 in a desktop browser.
---

# Testing safe-area-inset / mobile layout CSS (clients/web)

## Why this is tricky
`env(safe-area-inset-top)` / `--safe-area-inset-top` resolve to **0px** in a
desktop browser — the notch only exists on real iOS. So a layout bug that only
appears when the inset is non-zero is invisible unless you **simulate** it.

## Environment
- Storybook runs at `http://localhost:6007` (script: `bun run storybook`, `-p 6007`).
- Chrome CDP is at `http://localhost:29229` for scripted measurement.
- Python Playwright is available (`python3 -m playwright`, pyenv shim) — use it
  to `connect_over_cdp` and read `getComputedStyle`. The `playwright` npm package
  is NOT installed in `clients/web`, so prefer the Python client.

## Simulate the inset
Wrap the component under test in a container that sets the CSS variable directly:
```tsx
<div style={{ ["--safe-area-inset-top" as string]: "47px" }}> ... </div>
```
47px ≈ a real iPhone notch/Dynamic Island. Add a hatched strip of that height to
visualize the physical notch region in screenshots.

## Make the test adversarial: real-component branch A/B
The strongest proof renders the **real component from both branches side by side**
so a broken layout looks visibly different:
1. Export main's version as a renamed temp component (avoids symbol collision):
   ```bash
   git show origin/main:clients/web/src/.../thing.tsx \
     | sed -e 's/export function Thing(/export function ThingMain(/' \
           -e 's/ThingProps/ThingMainProps/g' \
     > clients/web/src/.../_thing-main.tsx
   ```
2. In a temp `_*.stories.tsx`, render `<ThingMain/>` (before) next to the real
   `<Thing/>` (after), each inside a simulated-inset container. Model each
   branch's inset ownership with story flags (e.g. `shellInset` / `bannerInset`).
3. Measure with Playwright CDP + `getComputedStyle` — assert concrete px values
   (e.g. header `padding-top` 63px before vs 16px after; the delta should equal
   the simulated inset). A vague "looks tighter" is not enough.

## Cleanup (important)
Temp stories and the `_*-main.tsx` copy are test-only. Delete them before
finishing so nothing is committed:
```bash
rm -f clients/web/src/.../_*-test.stories.tsx clients/web/src/.../_thing-main.tsx
git status --short   # must be clean
```

## What CAN'T be tested here (call out honestly in the report)
- Components that transitively import store-heavy children (e.g. `SidebarShell`
  pulls in `StatusBanner`) may not render standalone in Storybook — verify by
  code + `bunx tsc --noEmit` only.
- Keyboard-open behavior (`visualViewport`) needs a real iOS keyboard; not
  reproducible on desktop. Note: notch inset and `visualViewport.offsetTop` are
  independent top offsets that must **stack** (`calc(offset + inset)`), not
  replace each other.
- No live iOS device/simulator is available; state this rather than implying it.

## Checks before finishing
`cd clients/web && bunx tsc --noEmit && bun run lint` (the pre-commit hook also
runs both). The ESLint `curly` rule requires braces on every if/else/for/while.

## Devin Secrets Needed
None — Storybook and Chrome CDP run locally with no auth.
