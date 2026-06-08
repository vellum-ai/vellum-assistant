# Responsive Baseline & Mobile-First Mode

Every app must work across phone (~360px) to desktop (~1400px+).

## Mode selection

The conversation context's `<turn_context>` block carries an `interface:` field.

**If `interface: ios`** (or any future mobile-web / android identifier):
  → Mobile-first build. Design the narrow viewport first, enhance upward.

**If `interface: macos` or `web`**:
  → Desktop-first build. Design larger composition first; narrow fallback still meets the universal baseline below.

**If field is absent or ambiguous**:
  → Default to desktop-first unless the request implies phone use ("for my iPhone", "a tap-tracker I'll use on the go").

---

## Universal baseline (every build, regardless of interface)

### Viewport & safe areas

- Set viewport meta: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`. Never set `user-scalable=no` — it blocks accessibility zoom.
- Pad the root container with `env(safe-area-inset-*)` so content clears the notch: `padding-top: max(var(--v-spacing-lg), env(safe-area-inset-top))`, mirrored for `-bottom` / `-left` / `-right`.
- Use `100dvh` (dynamic viewport height), not `100vh`, for full-height containers.

### Form controls

- `<input>`, `<textarea>`, `<select>` must be `font-size: 16px` or larger, or iOS Safari will zoom on focus and break the layout. This applies to every build.
- Add `inputmode` to text fields with structured input: `numeric` for integers, `decimal` for amounts, `email`, `tel`, `url`.

### Touch & hover

- Interactive elements must be ≥44×44pt. `.v-button` already meets this; for custom controls, set `min-height: 44px` explicitly.
- Gate hover affordances behind `@media (hover: hover)` so they don't stick on touch devices.
- Disable text selection on app chrome with `user-select: none; -webkit-user-select: none`.

### Layout fluidity

- Use fluid widths only. No fixed-pixel layouts. Prefer `%`, `fr`, `minmax`, `clamp()` over `px` on container widths.
- At narrow widths, collapse tables into stacked cards with labels and values arranged vertically.
- Size `vellum.widgets.*` chart containers in `vw` / `%`, not fixed `px`.

---

## Mobile-first priorities (`interface: ios`)

- Default body text to `--v-font-size-lg` (17px), not `--v-font-size-base` (14px).
- Bump default vertical rhythm one step (e.g. `--v-spacing-md` → `--v-spacing-lg`).
- One column as the default, not a fallback. Opt into multi-column only above `@media (min-width: 720px)`.
- Bottom-anchor the primary action: `position: sticky; bottom: env(safe-area-inset-bottom)`.
- Replace side modals and popovers with bottom sheets.

## Desktop-first priorities (`interface: macos` / `web`)

Multi-column composition, hover-rich affordances, denser information, side modals, inline primary actions. The universal baseline above is still the floor — narrow view must still work.
