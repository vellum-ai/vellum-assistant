---
name: visualize
description: Render a polished visual inline in the chat as part of your answer — a diagram, a chart, an interactive explainer, or a UI mockup. Load it proactively whenever an explanation would land better as a picture than as prose. Do not wait to be asked.
metadata:
  emoji: "📊"
  vellum:
    display-name: "Visualize"
    category: "content"
    always-candidate: true
    activation-hints:
      - "Explaining how something works, or how the parts of a system relate to each other"
      - "Comparing options, tradeoffs, or before and after states side by side"
      - "Walking through numbers, rates, growth, or a distribution the user should see"
      - "Teaching a concept step by step, where the user should be able to move through it"
      - "Answering how would you explain this, or helping the user teach or onboard someone else"
    avoid-when:
      - "Simple factual answers where a sentence or a markdown list already says it"
      - "Durable apps or tools the user will reopen and keep using — use the app-builder skill"
---

You are authoring a self-contained HTML fragment that renders inline in the chat transcript, directly beneath the paragraph you are writing. It renders in a sandboxed frame sized to your content, with the host's design tokens injected, so it looks native in light and dark mode.

## Invocation

```
ui_show { surface_type: "visual", data: { html: "<fragment>", height: 320 } }
```

- `height` is a rough pixel estimate (80 to 1400); the host measures and corrects after first paint.
- One visual per call. To change one already shown, `ui_dismiss` its `surface_id` and show a new one.
- Prose goes in your reply, the visual goes in the tool: no titles, intros, or captions inside the fragment, and never describe in prose what the visual already shows.
- If ui_show returns an error, read it, fix the arguments, and call again. Every rejection is fixable in the next call; never debug via shell or files, and never narrate retries.

A visual is part of one answer. Durable things the user reopens (a dashboard, a tracker, a calculator they keep) are apps: use the `app-builder` skill.

## Design instincts

- Seamless and flat: no gradients, shadows, glow, or texture. Flat fills, hairline borders.
- Compact and honest: show the essential, explain the rest in prose; every number on screen is one you actually have.
- Pick the lightest form that carries the idea, and invent freely: a bespoke drawing that fits this answer beats a stock layout. Interaction has to earn its place; steppers are for stages that genuinely follow one another, tabs are not a default. Vary layout between visuals in one conversation.
- Route diagrams on the verb: "walk me through" wants a flowchart; "how is it organised" wants containment boxes; "how does it actually work" wants the mechanism drawn as an intuition, not a safer flowchart.

## Sandbox constraints (hard)

- No network: no script src, stylesheets, @import, remote images, web fonts, fetch, or CDN libraries. Charts and diagrams are hand-drawn inline SVG; images are inline SVG only.
- Fragment only: no DOCTYPE, html, head, or body. No HTML comments, no emoji.
- Hard cap 24000 characters; aim well under 8000. Too big to fit is too big to render. Split rich subjects into two visuals with prose between.
- No position fixed or sticky, no nested scrollbars: the frame auto-sizes from in-flow content.
- No localStorage, sessionStorage, or cookies. Hold state in JS variables.

## Fragment structure

Order: a visually hidden `<h2 class="sr-only">` one-sentence summary, a short style block, the markup, one script element last. Always quote every attribute value (`class="row-box hit"`, never `class=row-box hit`). Include verbatim when using sr-only:

```css
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
```

Usable width is about 660px; the host insets content 6px vertically and 10px from the sides. Rows holding controls carry their own padding of at least 8px on the crowded sides. Keep the outer background transparent.

## Design tokens

The COMPLETE list of injected CSS variables. Any other var() name is rejected unless your own style block declares it. Never hardcode a colour: hex, rgb(), hsl(), and oklch() literals are rejected everywhere, including SVG fill and stroke; only `transparent` and `currentColor` are allowed.

Semantic tokens flip automatically between light and dark. Use them for every surface, body text, border, and status colour:

- Surfaces: --surface-base (page), --surface-lift (card), --surface-overlay, --surface-sunken (recessed tile), --surface-hover, --surface-active.
- Text, strongest to faintest: --content-emphasised, --content-strong, --content-default (body), --content-secondary (labels and any text under 14px), --content-tertiary (14px and up only), --content-quiet, --content-faint, --content-disabled, --content-inset (on inverted fills). Text at 11 to 13px always takes --content-secondary or stronger.
- Borders: --border-base (hairline), --border-subtle, --border-element (visible control edge), --border-hover, --border-active, --border-disabled.
- Status pairs: --system-positive-strong/-weak, --system-negative-strong/-weak (and --system-negative-hover), --system-mid-strong/-weak, --system-info-strong/-weak. A non-text glyph sitting on its own -weak fill takes --system-positive-on-weak or --system-negative-on-weak; those clear the 3:1 that non-text indicators need, which --system-negative-strong misses on --system-negative-weak in the dark theme. Text on a -weak fill needs 4.5:1 and takes --content-default or stronger; --content-tertiary misses that on both fills in the light and dark themes, and --content-secondary misses it on the negative fill in light.
- Type: --font-sans (default), --font-mono (identifiers, code, tabular numbers only), --font-serif (editorial pull-quotes only).
- Radius: --radius-xs 2, --radius-sm 4, --radius-md 8, --radius-lg 12, --radius-xl 16, --radius-xxl 20, --radius-pill 999.

Palette ramps are for categorical encoding only, never page surfaces or body text: --color-moss-50..950 and --color-stone-50..950 (neutrals), --color-forest-100..950, --color-emerald-100..950, --color-danger-100..950, --color-amber-100..950. Stops run light (100) to dark (950). Author every ramp use against the light theme as a matched triple from ONE ramp, and the host mirrors it in dark mode as a unit:

```css
background: var(--color-forest-100);
border-color: var(--color-forest-600);
color: var(--color-forest-900);
```

The two rules the mirror imposes: text on a tinted fill takes the same ramp's 900 (secondary 800), never a --content-* token; and text sitting on the page (SVG labels, axis ticks, anything outside a tinted fill) takes --content-*, never a bare ramp stop. A dark ramp stop used as text is only valid where its light counterpart is painted right there on the same element or enclosing group.

Colour discipline: colour encodes category, not sequence. At most two accent ramps per visual plus a neutral, one accent moment per visual, system tokens only for genuine success/failure/warning/info, and a one-line legend whenever colour carries meaning. Never distinguish categories by colour alone; pair with a label or shape.

## Typography and spacing

- Sizes: 18px section label, 15px item title, 14px body (default), 12px secondary, 11px floor. Weights 400 and 500 only. Sentence case everywhere.
- Line-height 1.6 for prose; vertical rhythm in rem (0.5, 1, 1.5, 2); internal gaps in px (8, 12, 16).
- Card: --surface-lift, 1px --border-base, --radius-lg, padding 1rem 1.25rem. Tile: --surface-sunken with a 1px --border-subtle (it dissolves into the light page without the hairline), --radius-md.
- Buttons and pills take --radius-pill or --radius-sm, one choice per visual. No box-shadow except a focus ring. Size height to content honestly; no empty bands.
- Round every displayed number (Math.round, toFixed, toLocaleString); give range inputs an explicit step so the control emits round values.

## Complexity budget (hard)

At most 4 items across one row, 5 diagram nodes, 2 ramps, 5-word subtitles. Past any of these, split into two visuals with prose between. Over roughly 8000 characters means you are building too much.

## SVG mechanics

Anything with nodes and arrows is ONE inline SVG with `width="100%"` and `viewBox="0 0 680 H"`, never a row of HTML divs (divs clip silently at the frame edge; SVG scales). Skeleton:

```html
<svg width="100%" viewBox="0 0 680 320" role="img">
  <title>One sentence.</title>
  <desc>What the boxes and arrows are.</desc>
  <style>
    text{font-family:var(--font-sans)}
    .th{font-size:14px;font-weight:500;fill:var(--content-strong)}
    .ts{font-size:12px;fill:var(--content-secondary)}
    .box rect{fill:var(--surface-lift);stroke:var(--border-element)}
    .arr{stroke:var(--border-element);fill:none;marker-end:url(#a)}
  </style>
  <defs><marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round"/></marker></defs>
</svg>
```

- Keep viewBox width 680 (one unit = one CSS pixel). Lay nodes out on the grid below instead of computing positions: it is already sized so nothing overlaps and nothing clips, so there is no spacing arithmetic to do, and the validator checks bounds for you on submit.
  - Node width 140, height 44 (single line, text at y + 22) or 56 (title at y + 20, subtitle at y + 38).
  - 4 nodes across: x = 30, 200, 370, 540. 3 across: x = 60, 270, 480. 2 across: x = 120, 420.
  - Rows at y = 20, 110, 200, 290. viewBox height = last row's y + 80.
  - Horizontal arrows run between node edges at the node's mid height. Arrow labels fit only at 2 or 3 nodes across (12 above the arrow, centred on the gap); at 4 across the gaps are 30px, nothing fits, so leave those arrows unlabeled and carry the verbs in your prose.
  - Containers wrap a row group with 16 of margin; free-form shapes for illustrative drawings stay inside one grid cell or one row band.
- Every coordinate is an absolute viewBox coordinate. Never use the transform attribute: translated groups mix local and absolute positions and labels land outside their boxes (the validator rejects transforms). A node is a rect plus its text at the rect's own position:

```html
<g class="n-forest">
  <rect x="200" y="110" width="140" height="56" rx="8" />
  <text class="th" x="270" y="130" text-anchor="middle" dominant-baseline="central">Resolver</text>
  <text class="ts" x="270" y="148" text-anchor="middle" dominant-baseline="central">checks cache</text>
</g>
```

- Node titles fit at about 13 characters; subtitles at 5 words. Longer means shorten the words, never the spacing. SVG text never wraps; no rotated text.
- Background fills scope to the shape, never the group: `.note rect{fill:var(--surface-sunken)}`, not `.note{fill:...}`. fill inherits to text, so a group-level surface fill silently repaints the labels inside it in the background colour.
- Every text element needs `dominant-baseline="central"` with y at the centre of its slot. Two sizes only: 14px titles, 12px everything else.
- Any path or polyline used as a line carries `fill="none"` or it renders as a black blob. Strokes: 1px structure, 2px chart line. One arrowhead marker is the whole of defs; no filters, no gradients.
- A coloured node applies its matched ramp triple as one class on the group containing rect and text together.
- Charts: 2px lines, no dot per datum unless points are the story; bars with rx 2 and a 4px gap minimum; gridlines 1px --border-subtle; label axes directly rather than with a legend when there are two series or fewer.

## Interaction mechanics

One state object, one render() function, handlers mutate state and call render(); call render() once at the end of the script so the first paint is populated. Controls are unstyled by the sandbox; style them yourself:

```css
.btn{padding:6px 12px;border-radius:var(--radius-md);border:1px solid var(--border-element);background:transparent;font:400 13px var(--font-sans);color:var(--content-default);cursor:pointer}
.btn:hover{background:var(--surface-hover)}
```

- Selected state lives on aria-pressed or aria-selected and the CSS keys off that attribute. Every control is a real button or input, never a clickable div; glyph-only controls get aria-label.
- Range inputs: min, max, value, explicit step; recompute on `input`; put the live readout beside the control with a min-width so digits do not jitter.
- A static table is better as markdown in your reply; a table earns a fragment only when rows react to interaction. Use table-layout:fixed and --font-mono at 12px.

A global `sendPrompt(text)` sends text to the chat as though the user typed it, for follow-ups that need you to think ("Compare last quarter"). Give such controls a trailing arrow glyph (&#8599;). Filtering, sorting, and recomputing happen in local JS instead, instantly. sendPrompt fires only from a real user click, never on load or a timer.

## Accessibility

HTML fragments open with the sr-only h2; a lone-SVG fragment instead carries role="img" with title and desc as its first children. Toggle state never lives on colour alone.

## Now compose

Everything you need is above, and none of it needs verifying in advance: the grid already spaces things, and the validator checks tokens, contrast, and bounds when you submit, telling you exactly what to change if anything is off. Pre-checking coordinates, estimating label widths, or reviewing markup in your head duplicates work the validator does in milliseconds.

Your next action is the ui_show call itself. Your entire reasoning budget for this visual is a few sentences: name the form, name the grid slots you will use, done. Markup written in reasoning does not render, does not count as showing the user anything, and has to be written all over again inside the call, so a draft there spends the entire budget and produces nothing on screen. Compose the fragment for the first time inside `data.html` as you write the call. If you notice yourself reasoning about the fragment's contents, stop and start the call.
