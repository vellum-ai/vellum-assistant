# Meadow Design System

## Design Language

**Concept:** Your agent is a small creature that hatches, grows, and earns trust over time. The visual language is warm, organic, and playful — pixel art charm meets modern UI polish. Think *Stardew Valley meets a clean SaaS dashboard*.

**Creature:** A baby dino/dragon hybrid. Dino is more approachable and friendly (less intimidating than a dragon), but calling it a "companion" keeps it species-ambiguous and allows future evolution. Start as an egg → baby dino → grows with trust.

---

## Route Group Structure

The app uses Next.js route groups to separate themes:

- **`src/app/(app)/`** — App pages (assistant, settings, login, etc.) using the Meadow theme via `meadow.css`
- **`src/app/(marketing)/`** — Marketing pages (homepage, pricing, blog, etc.) with `marketing.css`
- **Theme CSS lives in each route group directory** and is imported by the route group's `layout.tsx`
- Components are organized under `src/components/app/`, `src/components/marketing/`, and `src/components/shared/`

---

## Color Palette

```
Sky Teal (Primary/Background)
  50:  #e6f0f4    100: #c2dce4    200: #9ac5d2
  300: #6eaabb    400: #4a8fa5    500: #2d6b7a
  600: #1a4a5e    700: #153d4e    800: #0f2b36
  900: #0a1d24

Meadow Green (Secondary)
  50:  #edf7ed    100: #d1ecd1    200: #b1dfb1
  300: #8ed28e    400: #6ec46e    500: #5cb85c
  600: #3a7a3a    700: #2d602d    800: #1f451f
  900: #142d14

Poppy Orange (Accent / CTA)
  50:  #fef3ec    100: #fce0cc    200: #f9cba8
  300: #f4a261    400: #f0913f    500: #e8834a
  600: #d06b2f    700: #b25520    800: #8a4018
  900: #632e11

Lavender Blue (Secondary accent)
  50:  #f0f2f9    100: #dde2f1    200: #c5cde6
  300: #a3b4d8    400: #8da0ce    500: #7b8ec4
  600: #5f71a8    700: #4a5987    800: #374267
  900: #252d47

Cloud Cream (Neutrals)
  50:  #fdfcfa    100: #f5f0ea    200: #ede6db
  300: #e8ddd0    400: #d4c9a8    500: #c4b894
  600: #a89a72    700: #8a7d5b    800: #6b6047
  900: #4d4533

Dino Green (Character/Success)
  50:  #eefaec    100: #d5f2d0    200: #b8e8af
  300: #8ed883    400: #6abf5e    500: #52a844
  600: #3e8a34    700: #306b28    800: #234d1d
  900: #173314
```

### Semantic Usage

| Role              | Light Mode     | Dark Mode       |
|-------------------|----------------|-----------------|
| Background        | cloud-50       | sky-800         |
| Surface           | white          | sky-700         |
| Surface elevated  | cloud-100      | sky-600         |
| Text primary      | sky-800        | cloud-50        |
| Text secondary    | sky-500        | cloud-300       |
| Text muted        | cloud-600      | cloud-500       |
| Border            | cloud-200      | sky-600         |
| Primary action    | poppy-400      | poppy-400       |
| Primary hover     | poppy-500      | poppy-300       |
| Success / growth  | dino-400       | dino-300        |
| Info / secondary  | lavender-400   | lavender-300    |
| Ring / focus      | dino-400/30%   | dino-400/30%    |

---

## Animation Patterns

### Keyframes (defined in `meadow.css`)

- **wobble** — Egg interaction feedback (0.3s ease-in-out)
- **bob** — Gentle idle movement (3s infinite)
- **fadeInUp** — Content entrance (0.5s ease-out)

### Animation by Principle

| Principle         | Animation                                      |
|-------------------|-------------------------------------------------|
| **Inviting**      | Egg bobs gently, hover glow, satisfying wobble  |
| **Yours**         | Name input springs in, personalized color shift  |
| **Not You**       | Dino blinks independently, idle sway animation   |
| **Earn Trust**    | Progress dots fill, trust meter grows over time   |

### Recommended: Use `motion` (Framer Motion v11+)

- Declarative, React-first, spring physics built in
- `AnimatePresence` handles mount/unmount beautifully (egg→dino swap)
- Layout animations for when UI shifts after hatching
- Gesture support for tap, drag, hover — all needed for egg interaction

---

## Key Recommendations

**Font pairing:**
- **Nunito** (display/headings) — rounded, friendly, warm
- **Quicksand** (body) — geometric, clean, still playful
- Both are variable fonts loaded in the root layout

**Signature radius:** `--radius-meadow: 14px`

**Pixel art:**
- Keep sprites as SVG `<rect>` grids — they scale perfectly and stay crisp
- Use `image-rendering: pixelated` on any raster fallbacks
- The pixel aesthetic creates a charming contrast with the polished UI chrome
