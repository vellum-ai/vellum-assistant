# Diagram

Hand-drawn SVG for flowcharts, structural diagrams, and illustrative mechanism drawings. Frame setup, coordinate rules, text rules, and the ramp triple are in SKILL.md under "SVG mechanics" — this covers what is specific to diagrams.

One inline SVG with a viewBox and `width="100%"`, always. A row of HTML divs is never a diagram here: it keeps its authored widths and the frame clips it at the right edge, silently. Every rule below is in viewBox units.

## Choosing the family

Route on the verb, not the noun. Ask whether the user wants to document this or to understand it.

- Flowchart — steps in sequence, branching decisions, a transformation pipeline. Triggered by "walk me through", "what are the steps", "what happens when".
- Structural — containment, things inside other things. Triggered by "what is the architecture", "how is this organised", "where does X live". Large rounded container with a label at top-left, smaller regions inside it, external inputs and outputs outside with arrows crossing the boundary.
- Illustrative — the user wants a mental model, not a map. Draw the mechanism or a spatial metaphor: a hash table as a row of buckets with items falling in, TCP as two endpoints passing numbered envelopes. Triggered by "how does X actually work", "I do not get X", "give me an intuition". This is the default for an unqualified "how does X work"; do not retreat to a flowchart because it feels safer.

Do not mix families in one diagram. If both are useful, draw the intuition first, then the reference version as a second call with prose between.

Two things do not belong here. Cycles are not drawn as rings — every rule here is Cartesian, and a ring layout produces overlapping satellites and tangential arrows. Build a stepper instead (see `interactive.md`), where the last step wrapping to the first is the loop; a linear row with one curved return path is acceptable only when there is a single input, a single output, and no per-stage detail. Database schemas and entity relationship diagrams are a text-layout problem that hand-placed SVG fails at — render them as an HTML table pair with a short prose description of the joins, or as markdown in your reply.

## Node patterns

Single-line node, 44px tall:

```html
<g class="box">
  <rect x="60" y="40" width="180" height="44" rx="4" />
  <text
    class="th"
    x="150"
    y="62"
    text-anchor="middle"
    dominant-baseline="central"
    >Gateway</text
  >
</g>
```

Two-line node, 56px tall, title plus a subtitle of at most five words:

```html
<g class="n-forest">
  <rect x="60" y="40" width="200" height="56" rx="4" />
  <text
    class="th"
    x="160"
    y="60"
    text-anchor="middle"
    dominant-baseline="central"
    >Staging table</text
  >
  <text
    class="ts"
    x="160"
    y="78"
    text-anchor="middle"
    dominant-baseline="central"
    >Verbatim copy of source</text
  >
</g>
```

For a two-line box at (x, y, w, h): title at y + 20, subtitle at y + 38, both text-anchor middle at x + w/2.

One class per category, on the group that directly contains the shapes or on the shape itself. Two ramps maximum, plus the neutral `.box` class for structural or start and end nodes.

```css
.n-forest rect {
  fill: var(--color-forest-100);
  stroke: var(--color-forest-600);
}
.n-forest .th {
  fill: var(--color-forest-900);
}
.n-forest .ts {
  fill: var(--color-forest-800);
}
```

Connector, unlabelled whenever source and target make the meaning obvious:

```html
<line x1="240" y1="62" x2="300" y2="62" class="arr" marker-end="url(#a)" />
```

## Packing math

Compute the total before placing anything. Safe area is x 40 to 640, y 30 to (height minus 24).

- Four boxes is the ceiling for one row. A fifth does not fit the safe span at a readable width: wrap to a second row, or drop to a second diagram.
- Four 130px boxes with three 20px gaps is 580px, which fits the 600px safe span starting at x=40. Four 160px boxes is 640px plus gaps and will overlap.
- Every pair of boxes in a row needs at least 20px of clear space between them.
- Add up x + width for the rightmost box before placing it. Past 640 it runs into the safe margin, and past the viewBox width it is clipped away with no sign it was ever drawn.
- For trees, size the leaf row first; a parent is at least as wide as the sum of its children.

## Arrows

- Before drawing a line, trace its coordinates against every rect already placed. If it crosses the interior of an unrelated box or label, route around it with an L-bend path: `d="M x1 y1 L x1 ymid L x2 ymid L x2 y2"` with `fill="none"`.
- Leave about 10px between an arrowhead and the box it points at.
- Arrow labels are usually unnecessary. When one is genuinely needed, place it in clear space above the line, never on the midpoint of the stroke. A centred label extends half its width either side of its x, so check that span against the boxes the arrow runs between: at 12px a word is about 6.5px per character, and a label wider than the gap lands on top of a box.
- Feedback loops in a linear flow: do not draw a long arrow back across the layout. Use a short return path below the row, or say it in prose.

## Containers

- Group related regions with a dashed rect plus a label, not with a drawn illustration of the thing. A dashed rect labelled "reactor vessel" reads cleaner than an ellipse that clips its contents.
- Containers need 20px of internal padding and at most two levels of nesting.

## Checklist

1. Every text element has a class, a fill from a token, and dominant-baseline where it sits in a box.
2. No pair of unrelated elements overlaps. Labels do not touch arrows; boxes do not touch boxes.
3. All content sits inside the viewBox, x 0 to 680 and y 0 to the height, with the height set to the lowest point plus 24. Nothing is clipped at an edge.
4. Every connector path has fill="none" and every arrow ends short of its target.
5. Colours come only from tokens, and each ramp use is a matched fill, stroke, and text triple.
6. Five nodes or fewer, at most four in any one row, subtitles of five words or fewer, two ramps or fewer.
