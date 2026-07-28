/** Guidance for the `interactive` module of `visualize_guide`: vanilla-JS widgets. */
export const INTERACTIVE_GUIDE = `# Module: interactive

Small explorable widgets in plain HTML and vanilla JS — steppers, tabs, sliders, filters, live
calculations. No framework and no library: the sandbox loads nothing external.

## When to reach for this

- The concept has stages and the user needs to walk through them (a pipeline, a request lifecycle,
  a cycle whose last step returns to the first).
- A relationship only lands when the user can move a variable and watch the result.
- Two or three options need side-by-side comparison with the differences called out.

If the content is static and the user has nothing to change, draw a diagram or a chart instead. An
interactive widget with nothing worth interacting with is worse than a picture.

## State pattern

One state object, one render function, event handlers that mutate state and call render. Never
patch the DOM from several places.

    <script>
    const S = [
      {n:'1. Source', t:'Operational systems', d:'Raw rows in the apps that run the business.'},
      {n:'2. Staging', t:'Staging tables', d:'A near-verbatim landing copy, loaded fast.'},
      {n:'3. Transform', t:'Clean and conform', d:'Dedupe, cast, resolve keys to surrogates.'}
    ];
    let i = 0;
    const tabs = document.getElementById('tabs');
    S.forEach((s, k) => {
      const b = document.createElement('button');
      b.className = 'stg';
      b.textContent = s.n;
      b.onclick = () => { i = k; render(); };
      tabs.appendChild(b);
    });
    function render() {
      [...tabs.children].forEach((b, k) => b.setAttribute('aria-pressed', k === i));
      document.getElementById('lbl').textContent = S[i].t;
      document.getElementById('dsc').textContent = S[i].d;
    }
    function go(d) { i = (i + d + S.length) % S.length; render(); }
    render();
    </script>

Call render() once at the end so the widget is populated on first paint. Wrapping the index with
the modulo is what makes a cycle read as a cycle: Next on the last stage returns to the first.

## Controls

Nothing is pre-styled in the sandbox. Style controls yourself, in the style block, and keep it
short:

    .stg{padding:8px 14px;border-radius:var(--radius-md);border:1px solid var(--border-base);background:transparent;font:400 13px var(--font-sans);color:var(--content-secondary);cursor:pointer}
    .stg[aria-pressed="true"]{background:var(--surface-sunken);color:var(--content-strong);border-color:var(--border-element)}
    .btn{padding:6px 12px;border-radius:var(--radius-md);border:1px solid var(--border-element);background:transparent;font:400 13px var(--font-sans);color:var(--content-default);cursor:pointer}
    .btn:hover{background:var(--surface-hover)}
    input[type=range]{accent-color:var(--system-positive-strong);width:100%}

- Selected state goes on aria-pressed (segmented controls, steppers) or aria-selected (tabs), and
  the style keys off that attribute. Never track selection in a class alone.
- Range inputs need min, max, value, and an explicit step so the value is already rounded.
- Put the live readout next to the control, 14px weight 500, with a min-width so the layout does
  not jitter as digits change.
- Disable rather than hide a control that is temporarily unavailable.

## Slider pattern

    <div style="display:flex;align-items:center;gap:12px;margin:0 0 1.25rem">
      <label for="yr" style="font-size:13px;color:var(--content-secondary)">Years</label>
      <input id="yr" type="range" min="1" max="40" step="1" value="20" style="flex:1">
      <span id="yrOut" style="font-size:14px;font-weight:500;min-width:2ch">20</span>
    </div>

Recompute on the input event, not change, so the readout tracks the drag. Every derived number goes
through toFixed or toLocaleString before it reaches the DOM.

## Tabs and steppers

- Do not use display:none to hide panels you never intend to show. Render one panel at a time from
  state, as above — the hidden content simply does not exist in the DOM.
- Give the panel a min-height so switching between a short and a long stage does not make the frame
  jump.
- A stepper gets Back and Next at the bottom, spaced apart with justify-content:space-between, plus
  the segmented stage buttons at the top. Position indicators are fine, but the stage buttons
  already do that job — do not ship both.

## Tables

Tables belong in a widget only when they are part of the interaction (the rows change as the user
steps through). A static table is better as markdown in your reply.

    table.d{width:100%;border-collapse:collapse;font:400 12px var(--font-mono);table-layout:fixed}
    table.d th{text-align:left;font-weight:500;font-size:11px;color:var(--content-tertiary);padding:5px 8px;border-bottom:1px solid var(--border-base)}
    table.d td{padding:5px 8px;color:var(--content-default);border-bottom:1px solid var(--border-base);overflow:hidden;text-overflow:ellipsis}

table-layout:fixed plus overflow hidden is what keeps a wide table inside 680px. Six columns is the
practical ceiling; past that, drop columns rather than letting the table scroll.

## Layout

- Panel: background var(--surface-sunken), border-radius var(--radius-lg), padding 1rem 1.25rem.
- Grids: repeat(auto-fit, minmax(160px, 1fr)) with gap 12px. Use minmax(0, 1fr) rather than 1fr for
  explicit columns, otherwise a wide child pushes the column past the container.
- Keep the whole widget on one screen. If it needs scrolling it is two widgets.

## sendPrompt

Interaction that is pure computation stays local and instant. sendPrompt is for the follow-up that
needs you to reason:

    <button class="btn" onclick="sendPrompt('What happens to this pipeline if the source schema changes?')">Ask about schema drift &#8599;</button>

Never wire sendPrompt to an input event, a timer, or page load — it must come from a click.

## Checklist

1. render() is called once at the end and is the only thing that writes to the DOM.
2. Every displayed number is rounded.
3. Selection state is on aria-pressed or aria-selected and the CSS reads it.
4. Controls are real button and input elements with labels.
5. Colours come from tokens; the panel is sunken, the outer background transparent.
6. No timers, no auto-play, no network calls.
`;
