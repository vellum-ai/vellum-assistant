/** Guidance for the `diagram` module of `visualize_guide`: hand-drawn SVG. */
export const DIAGRAM_GUIDE = `# Module: diagram

Hand-drawn SVG for flowcharts, structural diagrams, and illustrative mechanism drawings. There is
no diagram library in the sandbox and no preloaded SVG classes — you define the handful of classes
you need in a style block at the top of the SVG.

## Setup

    <svg width="100%" viewBox="0 0 680 320" role="img">
      <title>How a request moves through the gateway</title>
      <desc>Three boxes left to right: client, gateway, service, connected by arrows.</desc>
      <style>
        text{font-family:var(--font-sans)}
        .t{font-size:14px;fill:var(--content-default)}
        .th{font-size:14px;font-weight:500;fill:var(--content-strong)}
        .ts{font-size:12px;fill:var(--content-secondary)}
        .box rect{fill:var(--surface-lift);stroke:var(--border-element);stroke-width:1}
        .arr{stroke:var(--border-element);stroke-width:1;fill:none}
      </style>
      <defs>
        <marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </marker>
      </defs>
      ...
    </svg>

Rules that follow from this setup:

- The 680 in the viewBox is load-bearing. It matches the container width, so one SVG unit is one
  CSS pixel and every width calculation below holds. If the content is naturally narrow, keep
  viewBox width at 680 and centre the content — never shrink the viewBox to hug it.
- Height: after laying out, take the lowest point of any shape or text baseline and add 24. Do not
  guess and do not leave a band of empty space at the bottom.
- Safe area x 40 to 640, y 30 to (height minus 24). Never use a negative coordinate.
- Background stays transparent. Do not wrap the SVG in a div with a background — the host already
  provides the card.
- Exactly one svg element per call. If a first attempt is wrong, replace it entirely.
- One marker in defs, nothing else. No filters, no gradients, no extra markers. The arrowhead uses
  context-stroke so it inherits whatever colour its line has.

## Coloured nodes

Ramps do not flip with the theme, so a coloured node needs a matched fill, stroke, and text triple.
Define one class per category and put it on the group holding the shape and its text:

    .n-forest rect{fill:var(--color-forest-100);stroke:var(--color-forest-600)}
    .n-forest .th{fill:var(--color-forest-900)}
    .n-forest .ts{fill:var(--color-forest-800)}

Use CSS child selectors carefully: put the category class on the group that directly contains the
shapes, or on the shape itself. Two ramps maximum, plus the neutral .box class for structural or
start/end nodes.

## Node patterns

Single-line node, 44px tall:

    <g class="box">
      <rect x="60" y="40" width="180" height="44" rx="4"/>
      <text class="th" x="150" y="62" text-anchor="middle" dominant-baseline="central">Gateway</text>
    </g>

Two-line node, 56px tall, title plus a subtitle of at most five words:

    <g class="n-forest">
      <rect x="60" y="40" width="200" height="56" rx="4"/>
      <text class="th" x="160" y="60" text-anchor="middle" dominant-baseline="central">Staging table</text>
      <text class="ts" x="160" y="78" text-anchor="middle" dominant-baseline="central">Verbatim copy of source</text>
    </g>

Connector, unlabelled whenever source and target make the meaning obvious:

    <line x1="240" y1="62" x2="300" y2="62" class="arr" marker-end="url(#a)"/>

## Text placement

- Every text element needs dominant-baseline="central" and a y at the centre of the slot it sits
  in. Without it, y is the baseline and the glyphs ride about 4px high.
- For a two-line box at (x, y, w, h): title at y + 20, subtitle at y + 38, both text-anchor
  middle at x + w/2.
- SVG text never wraps. A line break needs an explicit tspan with x and dy="1.2em". If a subtitle
  needs wrapping it is too long — shorten it.
- No rotated text. If an axis label does not fit horizontally, shorten it or move it.
- Only two sizes: 14px for node titles and region labels, 12px for subtitles and legends.
- text-anchor="end" extends left from x. At x below 60 the longest label runs off the canvas — use
  text-anchor="start" and right-align the column instead.

## Width and packing math

Estimate rendered width before placing anything:

- 14px weight 500: about 8px per character.
- 12px weight 400: about 6.5px per character.
- rect width = max(title characters times 8, subtitle characters times 6.5) + 32.

A 100px box holds a 9-character subtitle, not "files, APIs, streams" (20 characters, needs 162px).

Row packing: compute the total before placing. Four 130px boxes with three 20px gaps is 580px,
which fits the 600px safe span starting at x=40. Four 160px boxes is 640px plus gaps and will
overlap. Every pair of boxes in a row needs at least 20px of clear space between them. For trees,
size the leaf row first; a parent is at least as wide as the sum of its children.

## Arrows

- Before drawing a line, trace its coordinates against every rect already placed. If it crosses the
  interior of an unrelated box or label, route around it with an L-bend path:
  d="M x1 y1 L x1 ymid L x2 ymid L x2 y2" with fill="none".
- Any path or polyline used as a connector must carry fill="none". SVG defaults to a black fill and
  an unfilled connector renders as a large black blob.
- Leave about 10px between an arrowhead and the box it points at.
- Arrow labels are usually unnecessary. When one is genuinely needed, place it in clear space above
  the line, never on the midpoint of the stroke.
- Feedback loops in a linear flow: do not draw a long arrow back across the layout. Use a short
  return path below the row, or say it in prose.

## Rounding and containers

- rx="4" is the default. rx="8" for an emphasised node. rx="12" to rx="16" for a container.
  An rx at or above half the height makes a pill — deliberate only.
- Group related regions with a dashed rect plus a label, not with a drawn illustration of the thing.
  A dashed rect labelled "reactor vessel" reads cleaner than an ellipse that clips its contents.
- Containers need 20px of internal padding and at most two levels of nesting.
- Strokes are 1px. Thicker strokes read as noise at this scale.

## Choosing the diagram type

Route on the verb, not the noun. Ask whether the user wants to document this or to understand it.

- Flowchart — steps in sequence, branching decisions, a transformation pipeline. Triggered by
  "walk me through", "what are the steps", "what happens when".
- Structural — containment, things inside other things. Triggered by "what is the architecture",
  "how is this organised", "where does X live". Large rounded container with a label at top-left,
  smaller regions inside it, external inputs and outputs outside with arrows crossing the boundary.
- Illustrative — the user wants a mental model, not a map. Draw the mechanism or a spatial
  metaphor: a hash table as a row of buckets with items falling in, TCP as two endpoints passing
  numbered envelopes. Triggered by "how does X actually work", "I do not get X", "give me an
  intuition". This is the default for an unqualified "how does X work"; do not retreat to a
  flowchart because it feels safer.

Do not mix families in one diagram. If both are useful, draw the intuition first, then the
reference version as a second call with prose between.

Cycles do not get drawn as rings. Every rule here is Cartesian and a ring layout produces
overlapping satellites and tangential arrows. Build a stepper instead (see the interactive module),
where the last step wrapping to the first is the loop. A linear row with one curved return path is
acceptable only when there is a single input and a single output and no per-stage detail.

Database schemas and entity relationship diagrams are a text-layout problem that hand-placed SVG
fails at. Render them as an HTML table pair with a short prose description of the joins, or as
markdown in your reply.

## Checklist before finalising

1. Every text element has a class, a fill from a token, and dominant-baseline where it sits in a box.
2. No pair of unrelated elements overlaps. Labels do not touch arrows; boxes do not touch boxes.
3. All content sits inside x 0 to 680, and the viewBox height is the lowest point plus 24.
4. Every connector path has fill="none" and every arrow ends short of its target.
5. Colours come only from tokens, and each ramp use is a matched fill, stroke, and text triple.
6. Five nodes or fewer, subtitles of five words or fewer, two ramps or fewer.
`;
