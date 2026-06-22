# Presentation Slide Design

Slides are a different domain from apps. Skip app-specific patterns (contextual headers, search/filter, toast notifications, form validation, custom routes). Slides are static content — build navigation and layouts with custom HTML/CSS.

## Key principles

- One idea per slide — understood in 3 seconds
- Layout variety — 3+ different types per deck, never consecutive same-type
- 8 layout types: Title, Stats, Bullets, Quote, Comparison, Timeline, Visual/Immersive, Closing/CTA
- Bold backgrounds — dark, gradient, or strongly tinted
- Max 6 bullets per slide, max 3 sentences body text
- Never go below 15px for any visible text

## Navigation

Build slide navigation as your own component. Common patterns:
- Keyboard: `ArrowLeft` / `ArrowRight` / `Space` / `Escape`
- Click affordances at left/right edges
- Slide counter pill in a corner (e.g. `3 / 12`)
- Optional progress bar at the top

## Layout templates

- **Title** — Centered headline, optional subtitle, no body. Full-bleed background or gradient.
- **Stats** — One huge number, label below, supporting paragraph optional.
- **Bullets** — Heading + 3–6 short bullets. Avoid wall-of-text.
- **Quote** — Pull quote in large italic type, attribution below, contrasting background.
- **Comparison** — Two columns (before/after, us/them, problem/solution). Visual symmetry matters.
- **Timeline** — Horizontal or vertical sequence with dates and milestones.
- **Visual/Immersive** — Full-bleed image, gradient, or generated graphic with minimal text overlay.
- **Closing/CTA** — Headline + single call to action. Mirror the title slide aesthetic.

## What to avoid

- Generic Keynote / PowerPoint aesthetic (default white background, sans-serif body, bullet lists everywhere)
- Tiny text below 15px — slides are read across rooms
- Same layout type used 3+ times in a row — vary the rhythm
- Body paragraphs longer than 3 sentences — split into multiple slides
