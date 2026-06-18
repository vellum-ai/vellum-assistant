# Design System

A design system CSS is auto-injected inside a `@layer`, so your styles always take priority. It provides element defaults and automatic light/dark mode switching via `prefers-color-scheme`.

**Use `--v-*` variables and `.v-*` classes** — they handle light/dark mode automatically. No manual dark mode CSS needed.

---

## Design tokens

| Category        | Tokens                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backgrounds** | `--v-bg`, `--v-surface`, `--v-surface-border`                                                                                                                  |
| **Text**        | `--v-text`, `--v-text-secondary`, `--v-text-muted`                                                                                                             |
| **Accent**      | `--v-accent`, `--v-accent-hover`                                                                                                                               |
| **Status**      | `--v-success`, `--v-danger`, `--v-warning`                                                                                                                     |
| **Spacing**     | `--v-spacing-xxs` (2px) / `-xs` (4px) / `-sm` (8px) / `-md` (12px) / `-lg` (16px) / `-xl` (24px) / `-xxl` (32px) / `-xxxl` (48px)                              |
| **Radius**      | `--v-radius-xs` (2px) / `-sm` (4px) / `-md` (8px) / `-lg` (12px) / `-xl` (16px) / `-pill` (999px)                                                              |
| **Shadows**     | `--v-shadow-sm`, `--v-shadow-md`, `--v-shadow-lg`                                                                                                              |
| **Typography**  | `--v-font-family`, `--v-font-mono`, `--v-font-size-xs` (10px) / `-sm` (11px) / `-base` (14px) / `-lg` (17px) / `-xl` (22px) / `-2xl` (26px), `--v-line-height` |
| **Animation**   | `--v-duration-fast` (0.15s) / `-standard` (0.25s) / `-slow` (0.4s)                                                                                             |
| **Palettes**    | `--v-slate-{950..50}`, `--v-emerald-*`, `--v-violet-*`, `--v-indigo-*`, `--v-rose-*`, `--v-amber-*`                                                            |
| **Constant**    | `--v-aux-white` (always `#FFFFFF` in both modes — use for text on filled/accent backgrounds)                                                                    |

---

## Utility classes

`.v-button` (`.secondary` / `.danger` / `.ghost`), `.v-card`, `.v-list` / `.v-list-item`, `.v-badge` (`.success` / `.warning` / `.danger`), `.v-input-row`, `.v-empty-state`, `.v-toggle`.

⚠️ **Never hardcode `color: white` or `color: #fff`.** Use `var(--v-aux-white)` for text on filled/accent backgrounds, or `var(--v-text)` / `var(--v-text-secondary)` for text on surface backgrounds. Hardcoded white causes invisible text on light surfaces.

---

## Custom themes

When the user wants a specific branded look, write complete CSS with hardcoded colors and `@media (prefers-color-scheme: dark)` for dark variants. Don't mix `--v-*` auto-switching variables with hardcoded colors in the same element.

---

## Theme and dark mode

The `--v-*` tokens switch between light and dark automatically, so token-based UI needs no dark-mode code. For custom (non-token) colors that must follow the theme, use `@media (prefers-color-scheme: dark)` in CSS.
