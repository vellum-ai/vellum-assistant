# Interactive

Small explorable widgets in plain HTML and vanilla JS — steppers, segmented compares, sliders, filters, live calculations. No framework and no library. The state pattern, control styling, table styling, and layout grids are in SKILL.md under "HTML and control mechanics"; this covers what is specific to interaction.

## When to reach for this

- The concept has stages and the user needs to walk through them (a pipeline, a request lifecycle, a cycle whose last step returns to the first).
- Two states differ in a way that only lands when you can put them next to each other.
- A relationship only lands when the user can move a variable and watch the result.

If the content is static and the user has nothing to change, draw a diagram or a chart instead. An interactive widget with nothing worth interacting with is worse than a picture.

Three skeletons follow, in ascending order of how much interaction they earn. They are deliberately different shapes — match the shape to the content instead of folding every subject into the first one.

## Stepper — ordered stages

Only when there is a real sequence. Stage buttons at the top, one panel rendered from state, Back and Next at the bottom spaced apart with justify-content:space-between. Position indicators are fine, but the stage buttons already do that job — do not ship both.

```html
<script>
  const S = [
    { n: "1. Source", t: "Operational systems", d: "Raw rows from the apps." },
    { n: "2. Staging", t: "Staging tables", d: "A landing copy, loaded fast." },
  ];
  let i = 0;
  const tabs = document.getElementById("tabs");
  function render() {
    tabs.replaceChildren();
    S.forEach((s, k) => {
      const b = document.createElement("button");
      b.className = "stg";
      b.textContent = s.n;
      b.setAttribute("aria-pressed", k === i);
      b.onclick = () => {
        i = k;
        render();
      };
      tabs.appendChild(b);
    });
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

Style `.stg` off the `.btn` rule in SKILL.md with border-radius var(--radius-pill), then add the selected state:

```css
.stg[aria-pressed="true"] {
  background: var(--surface-sunken);
  color: var(--content-strong);
  border-color: var(--border-element);
}
```

Wrapping the index with the modulo is what makes a cycle read as a cycle: Next on the last stage returns to the first. This is the correct shape for anything circular — never draw a ring diagram.

## Segmented compare — two states at once

For before and after, option A against option B, with and without. There is no sequence, so there is no Back or Next: both columns stay on screen and a segmented pair decides which is highlighted. Usually the honest form when a stepper would only be dressing up a comparison. The two `.stg` buttons in `#seg` are built once like the stage buttons above; each onclick sets k and calls render().

```html
<script>
  const V = [
    { l: "Before", rows: [["Latency", "820 ms"]] },
    { l: "After", rows: [["Latency", "140 ms"]] },
  ];
  let k = 1;
  const seg = document.getElementById("seg");
  const cols = document.getElementById("cols");
  function render() {
    cols.replaceChildren();
    V.forEach((v, j) => {
      const c = document.createElement("div");
      c.className = j === k ? "col on" : "col";
      c.innerHTML =
        v.l +
        v.rows.map(([n, x]) => `<div>${n}<b class="v">${x}</b></div>`).join("");
      cols.appendChild(c);
    });
    [...seg.children].forEach((b, j) =>
      b.setAttribute("aria-pressed", j === k),
    );
  }
  render();
</script>
```

```css
.col {
  background: var(--surface-sunken);
  border-radius: var(--radius-md);
  padding: 12px;
}
.col.on {
  background: var(--color-forest-100);
  color: var(--color-forest-900);
}
.v {
  font: 500 14px var(--font-mono);
}
```

`#cols` is a two-column grid of minmax(0, 1fr). The highlighted column is the one accent moment — the other stays neutral, and only the values go in mono.

## Slider what-if — one variable, live numbers

For a relationship the user should feel. A label, a range input and a readout on one flex row, then the derived numbers below, recomputed on every input event. No panels, no tabs.

```html
<label for="r">Annual rate</label>
<input id="r" type="range" min="0" max="12" step="1" value="6" style="flex:1" />
<span id="ro" style="font:500 14px var(--font-mono);min-width:3ch">6%</span>
<div id="out"></div>
<script>
  const r = document.getElementById("r");
  function render() {
    const rate = Number(r.value);
    document.getElementById("ro").textContent = rate + "%";
    const bal = 10000 * Math.pow(1 + rate / 100, 10);
    document.getElementById("out").innerHTML =
      `<div class="tile">Balance after 10 years` +
      `<div class="v">$${Math.round(bal).toLocaleString()}</div></div>`;
  }
  r.addEventListener("input", render);
  render();
</script>
```

Recompute on the input event, not change, so the readout tracks the drag. The step keeps the raw value round; toFixed or toLocaleString keeps the derived ones round.

## Tabs and panels

- Do not use display:none to hide panels you never intend to show. Render one panel at a time from state — the hidden content simply does not exist in the DOM.
- Give the panel a min-height so switching between a short and a long stage does not make the frame jump. Size it to the longest panel, not beyond it.
- Tabs carry aria-selected; segmented controls and steppers carry aria-pressed.

## Filters and sorting

Filtering, sorting, toggling, and recomputing all stay in local JS so they are instant. Rebuild the rows inside render() from the state object rather than mutating individual cells. A table whose rows change with the interaction belongs in the fragment; a static one belongs in your reply as markdown.

## Handing back to the conversation

Interaction that is pure computation stays local. sendPrompt is for the follow-up that needs you to reason — a button carrying the question and the trailing arrow (the pattern is in SKILL.md). Place it at the end, after the thing it asks about. One is usually enough; two is the ceiling.

## Checklist

1. render() is called once at the end and is the only thing that writes to the DOM.
2. Every displayed number is rounded.
3. Selection state is on aria-pressed or aria-selected and the CSS reads it.
4. Controls are real button and input elements with labels.
5. Colours come from tokens; the panel is sunken, the outer background transparent.
6. No timers, no auto-play, no network calls, and sendPrompt only from a click.
