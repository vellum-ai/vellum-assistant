# Interactive

Small explorable widgets in plain HTML and vanilla JS — steppers, tabs, sliders, filters, live calculations. No framework and no library. The state pattern, control styling, table styling, and layout grids are in SKILL.md under "HTML and control mechanics"; this covers what is specific to interaction.

## When to reach for this

- The concept has stages and the user needs to walk through them (a pipeline, a request lifecycle, a cycle whose last step returns to the first).
- A relationship only lands when the user can move a variable and watch the result.
- Two or three options need side-by-side comparison with the differences called out.

If the content is static and the user has nothing to change, draw a diagram or a chart instead. An interactive widget with nothing worth interacting with is worse than a picture.

## Steppers

A stepper is the segmented stage buttons at the top, one panel rendered from state, and Back / Next at the bottom spaced apart with justify-content:space-between. Position indicators are fine, but the stage buttons already do that job — do not ship both.

```html
<script>
  const S = [
    {
      n: "1. Source",
      t: "Operational systems",
      d: "Raw rows in the apps that run the business.",
    },
    {
      n: "2. Staging",
      t: "Staging tables",
      d: "A near-verbatim landing copy, loaded fast.",
    },
  ];
  let i = 0;
  const tabs = document.getElementById("tabs");
  S.forEach((s, k) => {
    const b = document.createElement("button");
    b.className = "stg";
    b.textContent = s.n;
    b.onclick = () => {
      i = k;
      render();
    };
    tabs.appendChild(b);
  });
  function render() {
    [...tabs.children].forEach((b, k) =>
      b.setAttribute("aria-pressed", k === i),
    );
    document.getElementById("lbl").textContent = S[i].t;
    document.getElementById("dsc").textContent = S[i].d;
  }
  function go(d) {
    i = (i + d + S.length) % S.length;
    render();
  }
  render();
</script>
```

```css
.stg {
  padding: 8px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-base);
  background: transparent;
  font: 400 13px var(--font-sans);
  color: var(--content-secondary);
  cursor: pointer;
}
.stg[aria-pressed="true"] {
  background: var(--surface-sunken);
  color: var(--content-strong);
  border-color: var(--border-element);
}
```

Wrapping the index with the modulo is what makes a cycle read as a cycle: Next on the last stage returns to the first. This is the correct shape for anything circular — never draw a ring diagram.

## Tabs and panels

- Do not use display:none to hide panels you never intend to show. Render one panel at a time from state — the hidden content simply does not exist in the DOM.
- Give the panel a min-height so switching between a short and a long stage does not make the frame jump.
- Tabs carry aria-selected; segmented controls and steppers carry aria-pressed.

## Sliders

```html
<div style="display:flex;align-items:center;gap:12px;margin:0 0 1.25rem">
  <label for="yr" style="font-size:13px;color:var(--content-secondary)"
    >Years</label
  >
  <input
    id="yr"
    type="range"
    min="1"
    max="40"
    step="1"
    value="20"
    style="flex:1"
  />
  <span id="yrOut" style="font-size:14px;font-weight:500;min-width:2ch"
    >20</span
  >
</div>
```

Recompute on the input event, not change, so the readout tracks the drag. Every derived number goes through toFixed or toLocaleString before it reaches the DOM. The step keeps the raw value round; the formatter keeps the derived ones round.

## Filters and sorting

Filtering, sorting, toggling, and recomputing all stay in local JS so they are instant. Rebuild the rows inside render() from the state object rather than mutating individual cells. A table whose rows change with the interaction belongs in the fragment; a static one belongs in your reply as markdown.

## Handing back to the conversation

Interaction that is pure computation stays local. sendPrompt is for the follow-up that needs you to reason:

```html
<button
  class="btn"
  onclick="sendPrompt('What happens to this pipeline if the source schema changes?')"
>
  Ask about schema drift &#8599;
</button>
```

Place it at the end, after the thing it asks about. One such button is usually enough; two is the ceiling.

## Checklist

1. render() is called once at the end and is the only thing that writes to the DOM.
2. Every displayed number is rounded.
3. Selection state is on aria-pressed or aria-selected and the CSS reads it.
4. Controls are real button and input elements with labels.
5. Colours come from tokens; the panel is sunken, the outer background transparent.
6. No timers, no auto-play, no network calls, and sendPrompt only from a click.
