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

You are authoring a self-contained HTML fragment that renders inline in the chat transcript, directly beneath the paragraph you are writing. It renders in a sandboxed frame sized to your content, with the host's design tokens injected, so it looks native in both light and dark mode.

## Invocation

```
ui_show {
  surface_type: "visual",
  data: { html: "<fragment>", height: 320 }
}
```

- `data.html` is the fragment itself. `data.height` is optional.
- `height` is your best estimate of the rendered pixel height, clamped to 80–1400. The host measures the real content after first paint and corrects, so a rough number is fine — it only avoids a visible jump. Typical values: small chart 260, stepper 380, diagram 320.
- One visual per call. Two visuals means two calls with a paragraph of prose between them.
- To change a visual you already showed, `ui_dismiss` its `surface_id` and `ui_show` a new one. There is no partial update.
- After the call returns, keep writing normally. Never describe what the visual contains — the user is looking at it.
- If ui_show returns an error, read it, fix the arguments, and call ui_show again. Every rejection is about the arguments you sent and is fixable in the next call. Never reach for the shell, a file, or a log to diagnose it, and never narrate the attempts in your reply — the user should see the visual, not the retries.

Prose goes in your reply, the visual goes in the tool: no titles, headings, intros, captions, or explanatory paragraphs inside the fragment. The chat message around it carries all of that.

Pick the form and sketch the structure in a sentence or two of thought, then write the fragment. The fragment is written IN the ui_show call — once the form is chosen, emit the call and compose the markup there. Never draft it in your reasoning: markup written in thought has to be written again in the call, and a long enough draft runs out of tokens before the call is ever made. Do not deliberate at length and do not draft competing versions in your head — the validator catches mistakes and another call is cheap, so a thought budget spent weighing options is a budget that produces nothing on screen.

## Not this skill

Durable things the user reopens — a dashboard they check weekly, a tracker, a calculator they keep — are apps: use the `app-builder` skill. A visual is part of one answer. It lives in the transcript, holds no storage, and has no route.

## Philosophy

- Seamless — the user should not be able to tell where the chat ends and the visual begins.
- Flat — no gradients, shadows, blur, glow, or texture. Flat fills and hairline borders only.
- Compact — show the essential, explain the rest in prose.
- Honest — every number on screen is one you actually have or actually computed.

## Choosing the form

Pick the lightest form that carries the idea. A static annotated diagram or a side-by-side comparison beats a stepper whenever there is no real sequence — a stepper is for stages that genuinely follow one another, not for slicing a flat subject into slides. Interaction has to earn its place; tabs and steppers are not the default.

Vary the layout between visuals in one conversation. Two steppers in a row read as a template rather than as two answers.

## Sandbox constraints (hard)

The frame has no network access. Anything external is blocked and fails silently, leaving a broken visual on screen.

- No script src, no link rel=stylesheet, no CSS @import, no remote images, no web fonts, no fetch / XMLHttpRequest / WebSocket. There is no CDN.
- No charting library, no icon webfont, no diagram library. Charts and diagrams are hand-drawn in inline SVG.
- Images: inline SVG only. Do not paste photo data URIs — they blow the size budget.
- Fragment only: no DOCTYPE, no html, head, or body element.
- Hard cap 24000 characters, and aim for well under 8000. The cap is not a target: a fragment has to fit inside one response, and one that does not fit never renders at all. If the subject wants more, make two visuals with prose between them.
- No comments of any kind. They cost tokens and buy nothing.
- No emoji anywhere.
- No position fixed or sticky — frame height is derived from in-flow content, so out-of-flow elements collapse it.
- No nested scrollbars. The frame auto-sizes; let content determine height.
- No localStorage, sessionStorage, or cookies. Hold state in JS variables.

## Fragment structure

Write in this order — style first, script last, so the markup is meaningful the moment it lands:

1. A visually hidden h2 with class sr-only carrying one sentence describing the visual.
2. A short style block (under about 20 lines) for rules you would otherwise repeat.
3. The content markup, using inline style attributes for one-off styling.
4. A single script element at the very end.

Always quote attribute values. An unquoted multi-token class (`class=row-box hit`) parses as `class="row-box"` plus a junk attribute, so the second class's rules silently never apply and the visual loses its highlighting.

Include this rule verbatim whenever you use the sr-only heading:

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
```

The container gives you about 660px of usable width and insets all content 6px from the top and bottom edges and 10px from the sides, so nothing you draw can touch the frame's rounded corners. That inset is a floor, not comfortable spacing: rows that hold controls (a footer with back and next, a tab strip, a slider row) carry their own padding of at least 8px on the crowded sides, and never use negative margins to fight the inset. Add padding: 0.5rem 0 to the first element if you want more vertical breathing room. Keep the outer background transparent; the host supplies the chat background.

## Design tokens

What follows is the COMPLETE list of CSS variables that exist inside the frame. Nothing else is injected: a var() reference to any other name — --color-text-primary, --text-muted, --bg-card — resolves to nothing, the declaration is silently dropped, and the call is rejected. Do not invent names, and do not guess at names from other design systems.

You may declare your own custom properties in the fragment's own style block and use them (`:root{--gap:8px}` then `var(--gap)`); that is fine. What is rejected is referencing a name that is neither injected nor declared by you.

Two families, both theme-aware, but adapting in different ways. Knowing the difference is the single biggest defence against dark-mode bugs.

### Semantic tokens — flip automatically between light and dark

Use these for every surface, every piece of body text, every border, and every status colour.

- Surfaces: --surface-base (chat page), --surface-lift (raised card), --surface-overlay (popover), --surface-sunken (recessed panel or metric tile), --surface-hover, --surface-active.
- Text, strongest to faintest: --content-emphasised, --content-strong (emphasised), --content-default (body), --content-secondary (labels, and any text under 14px), --content-tertiary (hints, at 14px and larger only), --content-quiet (faintest still readable), --content-faint (decorative, below the readable floor), --content-disabled, --content-inset (on an inverted fill).
- --content-tertiary and fainter are size-gated: in light mode they land between 3.7 and 4.1 to 1 against the page, which fails AA below 14px. Every label at 11, 12, or 13px — table headers, axis ticks, tile captions, legends, the word required — takes --content-secondary or stronger.
- Borders: --border-base (hairline default), --border-subtle, --border-element (visible control border), --border-hover, --border-active, --border-disabled.
- Status, each a strong foreground paired with a weak tinted background: --system-positive-strong / -weak, --system-negative-strong / -weak (plus --system-negative-hover), --system-mid-strong / -weak (warning), --system-info-strong / -weak.
- Type: --font-sans (DM Sans, the default), --font-mono (DM Mono), --font-serif (Instrument Serif — editorial pull-quote moments only, never UI chrome).
- Radius: --radius-xs 2px, --radius-sm 4px, --radius-md 8px, --radius-lg 12px, --radius-xl 16px, --radius-xxl 20px, --radius-pill 999px.

### Palette ramps — mirror across themselves, for categorical encoding only

Six ramps. They exist for categorical encoding, never for page surfaces or body text.

- --color-moss-50 through --color-moss-950 — cool neutral
- --color-stone-50 through --color-stone-950 — warm neutral
- --color-forest-100 through --color-forest-950 — green
- --color-emerald-100 through --color-emerald-950 — green (same values as forest)
- --color-danger-100 through --color-danger-950 — orange-red
- --color-amber-100 through --color-amber-950 — yellow

Stops run 100 lightest to 950 darkest (moss and stone also have a 50).

Author every ramp value once, against the LIGHT reading: light fill, mid border, dark text. Inside the frame the host mirrors each stop onto its opposite in dark mode — 100 renders as 950, 200 as 900, 600 as 500, and so on down the ramp — so that one authored triple inverts as a unit and lands as a soft dark tint carrying light text. Never write a second set of values and never branch on the theme.

It only inverts as a unit if fill and text come from the same ramp, so always use a matched triple:

```css
background: var(--color-forest-100);
border-color: var(--color-forest-600);
color: var(--color-forest-900);
```

Title text on a tinted fill uses the 900 stop; secondary text on that fill uses 800. Never put --content-default (which flips to its own counterpart) on a ramp fill (which mirrors) — the two move independently and one of the modes loses the text.

The reverse is the more common mistake and is rejected outright: text sitting directly on the page background — every SVG label, axis tick, node title, and paragraph outside a tinted fill — uses --content-\* and never a ramp stop. The mirror pairs a ramp against itself, not against the page, so a bare ramp label has no reliable contrast: --color-forest-100 as text is invisible on the light page and mirrors to near-black in dark mode, and a bare --color-forest-900 label swaps from dark ink to a light tint between the two. The validator flags a dark ramp stop used as a text colour when the matching light stop is not painted right there — on the same element, in the same style rule, or on the group immediately around the label — and the converse case. A pill using that palette elsewhere in the fragment does not cover a bare label.

Never hardcode a colour for text, background, border, or SVG fill or stroke. Every colour comes from a variable above — hex literals (#2563eb), rgb(), rgba(), hsl(), and oklch() are rejected outright. Only transparent and currentColor are allowed as literal colour keywords.

## Colour discipline

- Colour encodes meaning, not sequence. Do not walk the ramps step 1 green, step 2 amber, step 3 red. Group by category: everything of one kind shares one ramp.
- At most two accent ramps per visual, plus neutral. The palette is deliberately narrow — moss or stone for structure, one accent for the thing that matters, a second only when the contrast between two categories is the point.
- One accent moment per visual. Most of the canvas stays neutral; an accent spread across three regions stops marking anything.
- Use the system tokens when the meaning is genuinely success, failure, warning, or information. Use ramps for everything else categorical.
- If colour carries meaning, add a one-line legend.

## Typography

- Default: 14px, weight 400, line-height 1.6, --font-sans.
- Sizes: 18px section label, 15px item title, 14px body, 12px secondary, 11px floor. No others.
- Below 14px the colour floor rises with the size: 11px to 13px text takes --content-secondary or stronger, never --content-tertiary or fainter.
- Weights: 400 and 500 only. Never 600 or 700 — they read heavy against the host UI.
- Sentence case everywhere, including SVG labels and table headers. Never Title Case, never ALL CAPS.
- Identifiers, column names, code, and tabular numbers go in --font-mono. Mono is for those alone — never a sentence, a label, a whole card, or a whole panel.
- No bold mid-sentence. Bold is for labels and headings.

## Shape and spacing

- Borders: 1px solid var(--border-base); use --border-element when the edge must stay visible against a lift surface.
- Card: background var(--surface-lift), 1px border, border-radius var(--radius-lg), padding 1rem 1.25rem.
- Tile (metric, stat): background var(--surface-sunken), 1px solid var(--border-subtle), border-radius var(--radius-md), padding 1rem. --surface-sunken equals the page background in light mode, so a borderless tile dissolves there and only reads in dark — anything sunken sitting directly on the page needs the hairline to hold its edge. A card on --surface-lift is already lifted off the page and keeps the guidance above.
- Controls: buttons and pills take var(--radius-pill) or var(--radius-sm) — pick one and use it for every control in the visual. Inputs and panels take var(--radius-sm) or var(--radius-md).
- Never round a single-sided border. A border-left accent gets border-radius 0.
- Vertical rhythm in rem (0.5, 1, 1.5, 2). Internal gaps in px (8, 12, 16).
- Size height to content honestly. No large empty vertical band above, below, or between blocks — a min-height goes to the tallest state, not beyond it, and the `height` you pass to ui_show is an estimate the host corrects, so never pad the fragment to fill it.
- No box-shadow except a functional focus ring.

## Numbers

Round every number that reaches the screen. Floating-point math leaks artefacts — 0.1 + 0.2 renders as 0.30000000000000004. Put every displayed value through Math.round, toFixed(n), or toLocaleString: integers for counts, one or two decimals for percentages, toLocaleString for currency. Give range inputs an explicit step so the control itself emits round values.

## sendPrompt(text)

A global function is available inside the frame:

```html
<button
  class="btn"
  onclick="sendPrompt('Show me the same breakdown for last quarter')"
>
  Compare last quarter &#8599;
</button>
```

It sends text to the chat as though the user typed it, and you answer it on the next turn. Use it for anything that needs you to think. Do not use it for filtering, sorting, toggling, or recomputing — do those in local JS so they are instant.

- A control that calls sendPrompt gets a trailing arrow glyph so the user knows it starts a turn.
- sendPrompt requires a real user click. Never call it on load, on a timer, or from a script that runs by itself.

## Links

An anchor with an https href works — clicks are intercepted and confirmed by the host. Keep links rare.

## Accessibility

- HTML fragment: open with the visually hidden sr-only h2 one-sentence summary.
- SVG fragment: the root svg carries role="img" with title and desc as its first two children, and no sr-only heading.
- Every interactive control is a real button or input, never a clickable div. Glyph-only controls need aria-label.
- Toggle state lives on aria-pressed or aria-selected, not only on colour.
- Never distinguish categories by colour alone — pair colour with a label, a shape, or a dash pattern.

## Complexity budget (hard limits)

- Item and node subtitles: 5 words maximum. Detail belongs in your prose or behind sendPrompt.
- One horizontal row: at most 4 items at full width. Five or more means shrink them, wrap to two rows, or split into two visuals.
- Ramps: 2 maximum.
- Diagram nodes: 5 maximum. Beyond that, draw two diagrams with prose between them.
- Over roughly 8000 characters means you are building too much.

## SVG mechanics

Shared by diagrams and charts. There is no diagram or charting library and no preloaded SVG classes — define the handful of classes you need in a style block at the top of the SVG.

```html
<svg width="100%" viewBox="0 0 680 320" role="img">
  <title>How a request moves through the gateway</title>
  <desc>
    Three boxes left to right: client, gateway, service, connected by arrows.
  </desc>
  <style>
    text {
      font-family: var(--font-sans);
    }
    .th {
      font-size: 14px;
      font-weight: 500;
      fill: var(--content-strong);
    }
    .ts {
      font-size: 12px;
      fill: var(--content-secondary);
    }
    .box rect {
      fill: var(--surface-lift);
      stroke: var(--border-element);
      stroke-width: 1;
    }
    .arr {
      stroke: var(--border-element);
      stroke-width: 1;
      fill: none;
    }
  </style>
  <defs>
    <marker
      id="a"
      viewBox="0 0 10 10"
      refX="8"
      refY="5"
      markerWidth="6"
      markerHeight="6"
      orient="auto-start-reverse"
    >
      <path
        d="M2 1L8 5L2 9"
        fill="none"
        stroke="context-stroke"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </marker>
  </defs>
</svg>
```

Coordinates

- The 680 in the viewBox is load-bearing. It matches the container width, so one SVG unit is one CSS pixel and every width calculation holds. If the content is naturally narrow, keep the viewBox width at 680 and centre the content — never shrink the viewBox to hug it.
- Height: after laying out, take the lowest point of any shape or text baseline and add 24. Do not guess and do not leave a band of empty space at the bottom.
- Never use a negative coordinate. Everything sits inside x 0 to 680.
- Background stays transparent. Do not wrap the SVG in a div with a background.
- Exactly one svg element per fragment when the fragment is a drawing. If a first attempt is wrong, replace it entirely.
- No filters, no gradients, no second marker. One arrowhead marker in defs is the whole of defs; context-stroke makes it inherit its line's colour.

Text

- Every text element needs dominant-baseline="central" and a y at the centre of the slot it sits in. Without it, y is the baseline and the glyphs ride about 4px high.
- Only two sizes: 14px for titles and region labels, 12px for subtitles, legends, and axis labels.
- SVG text never wraps. A line break needs an explicit tspan with x and dy="1.2em". If a label needs wrapping it is too long — shorten it.
- No rotated text anywhere, including axis ticks.
- text-anchor="end" extends left from x. At x below 60 the longest label runs off the canvas — use text-anchor="start" and right-align the column instead.
- Estimate rendered width before placing anything: 14px weight 500 is about 8px per character, 12px weight 400 about 6.5px. A box is max(title chars times 8, subtitle chars times 6.5) + 32 wide. A 100px box holds a 9-character subtitle, not "files, APIs, streams" (20 characters, needs 162px).

Strokes and shapes

- Any path or polyline used as a line must carry fill="none". SVG defaults to a black fill, so an unfilled connector renders as a large black blob.
- Strokes are 1px for structure, gridlines, and axes; 2px for a chart line. Thicker reads as noise at this scale.
- Rounding: rx="2" bars, rx="4" default node, rx="8" emphasised node, rx="12" to rx="16" containers. An rx at or above half the height makes a pill — deliberate only.
- A coloured shape needs a matched fill, stroke, and text triple, applied as one class per category on the group that directly contains the shapes (example in `diagram.md`).

## HTML and control mechanics

Shared by interactive widgets and mockups.

State: one state object, one render function, event handlers that mutate state and call render. Never patch the DOM from several places. Call render() once at the end so the fragment is populated on first paint.

Controls are unstyled. Nothing is pre-styled in the sandbox — no form reset, no button theme. Style them yourself in the style block, and keep it short:

```css
.btn {
  padding: 6px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-element);
  background: transparent;
  font: 400 13px var(--font-sans);
  color: var(--content-default);
  cursor: pointer;
}
.btn:hover {
  background: var(--surface-hover);
}
input[type="range"] {
  accent-color: var(--system-positive-strong);
  width: 100%;
}
```

- Selected state goes on aria-pressed (segmented controls, steppers) or aria-selected (tabs), and the style keys off that attribute. Never track selection in a class alone.
- Range inputs need min, max, value, and an explicit step so the value is already rounded. Recompute on the input event, not change.
- Put the live readout next to the control, 14px weight 500, with a min-width so the layout does not jitter as digits change.
- Disable rather than hide a control that is temporarily unavailable.

Tables. A static table is better as markdown in your reply. A table belongs in a fragment only when it is the object being shown or when its rows change as the user interacts.

```css
table.d {
  width: 100%;
  border-collapse: collapse;
  font: 400 12px var(--font-mono);
  table-layout: fixed;
}
table.d th {
  text-align: left;
  font-weight: 500;
  font-size: 11px;
  color: var(--content-secondary);
  padding: 5px 8px;
  border-bottom: 1px solid var(--border-base);
}
table.d td {
  padding: 5px 8px;
  color: var(--content-default);
  border-bottom: 1px solid var(--border-base);
  overflow: hidden;
  text-overflow: ellipsis;
}
```

table-layout:fixed plus overflow hidden is what keeps a wide table inside 680px. Six columns is the practical ceiling; past that, drop columns rather than letting the table scroll.

Layout

- Grids: repeat(auto-fit, minmax(160px, 1fr)) with gap 12px. Use minmax(0, 1fr) rather than 1fr for explicit columns, otherwise a wide child pushes the column past the container.
- Panel: background var(--surface-sunken), 1px solid var(--border-subtle), border-radius var(--radius-lg), padding 1rem 1.25rem — the same hairline a tile needs, for the same reason.
- Keep the whole thing on one screen. If it needs scrolling it is two visuals.

## When nothing fits

Pick the nearest reference pattern and adapt it. Explanatory content defaults to an editorial layout with no card wrapper; a bounded object defaults to a single card.

## References

Read the reference for the form you are drawing BEFORE authoring it, with `file_read` on `{baseDir}/references/...` (`{baseDir}` resolves to this skill's directory). Each covers only what is specific to that form; everything above applies to all four.

- `diagram.md` — flowcharts, structural and illustrative drawings. Node patterns, arrow routing, row and tree packing, choosing the diagram family, what not to draw as a diagram.
- `chart.md` — bars, lines, areas, donuts, sparklines. Mark choice, plot margins, scales, axes and gridlines, honesty rules.
- `interactive.md` — steppers, segmented compares, sliders, filters, live calculations. When interaction earns its place, plus three distinct skeletons to choose between.
- `mockup.md` — cards, records, forms, settings panels, faux screens. Metric tiles, badges, list rows, faux viewport for modals and phones.

Read a second reference when a visual mixes forms — a stepper whose panels contain a chart needs both.
