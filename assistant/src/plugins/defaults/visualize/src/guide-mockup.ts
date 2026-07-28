/** Guidance for the `mockup` module of `visualize_guide`: UI and bounded objects. */
export const MOCKUP_GUIDE = `# Module: mockup

Static UI: cards, records, forms, settings panels, dashboards, and faux screens. Use this when the
answer is an object the user can look at — a contact record, a receipt, a proposed screen, a
configuration — rather than a process or a dataset.

## Card

The workhorse. One raised card wraps a bounded object.

    <div style="background:var(--surface-lift);border:1px solid var(--border-base);border-radius:var(--radius-lg);padding:1rem 1.25rem">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <div style="width:44px;height:44px;border-radius:var(--radius-pill);background:var(--color-forest-100);color:var(--color-forest-900);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:500">AB</div>
        <div>
          <p style="margin:0;font-size:15px;font-weight:500;color:var(--content-strong)">Alice Boyd</p>
          <p style="margin:0;font-size:13px;color:var(--content-secondary)">Platform engineering</p>
        </div>
      </div>
      <div style="border-top:1px solid var(--border-base);padding-top:12px;display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px">
        <span style="color:var(--content-secondary)">Email</span>
        <span style="text-align:right;font-family:var(--font-mono)">user@example.com</span>
        <span style="color:var(--content-secondary)">Team</span>
        <span style="text-align:right">Infrastructure</span>
      </div>
    </div>

Initials circles use a matched ramp pair (light fill, 900 text). Keep the label column secondary and
the value column default.

## Metric tiles

Summary numbers sit in sunken tiles, not raised cards — the distinction is what keeps a dashboard
readable.

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px">
      <div style="background:var(--surface-sunken);border-radius:var(--radius-md);padding:1rem">
        <p style="margin:0 0 4px;font-size:13px;color:var(--content-secondary)">Active users</p>
        <p style="margin:0;font-size:24px;font-weight:500;color:var(--content-strong)">12,480</p>
      </div>
    </div>

Two to four tiles per row. Always format the number with toLocaleString. A delta goes underneath at
12px in --system-positive-strong or --system-negative-strong, with a plus or minus sign — never
colour alone.

## Badges and pills

    <span style="display:inline-block;padding:2px 10px;border-radius:var(--radius-pill);font-size:12px;background:var(--system-positive-weak);color:var(--system-positive-strong)">Active</span>

Status badges use the system weak/strong pairs. Categorical badges use a ramp triple (100 fill, 900
text). Never plain grey text on a coloured fill.

## Rows and lists

    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-base)">
      <span style="font-size:14px">Weekly digest</span>
      <span style="font-size:13px;color:var(--content-secondary)">Mondays, 9:00</span>
    </div>

Drop the border on the last row. List rows do not get their own card; the list as a whole does.

## Forms

Form controls are unstyled in the sandbox. A minimal, correct set:

    .fld{width:100%;box-sizing:border-box;height:36px;padding:0 10px;border:1px solid var(--border-element);border-radius:var(--radius-md);background:var(--surface-lift);color:var(--content-default);font:400 14px var(--font-sans)}
    .fld:focus{outline:none;border-color:var(--system-positive-strong);box-shadow:0 0 0 3px var(--ring)}
    .lbl{display:block;margin-bottom:6px;font-size:13px;color:var(--content-secondary)}

Every field has a real label element tied to the input by id. Stack fields with 1rem between them.
Mark required fields with the word required in --content-tertiary, not an asterisk. A mockup form
is a picture: give the submit button a sendPrompt handler or no handler at all, never a fake
success state.

## Faux viewport

Modals, mobile screens, and overlays cannot use position:fixed — the frame height comes from
in-flow content and a fixed element collapses it. Build a normal-flow container that contributes
real height:

    <div style="min-height:360px;border-radius:var(--radius-lg);background:var(--surface-sunken);display:flex;align-items:center;justify-content:center;padding:1.5rem">
      <div style="width:320px;background:var(--surface-lift);border:1px solid var(--border-base);border-radius:var(--radius-lg);padding:1.25rem">
        ...modal content...
      </div>
    </div>

The same wrapper works as a device frame for a phone screen: fix the inner width to 320px and let
the sunken surface be the surrounding desk.

## Presentation rules

- Contained mockups (a single card, a phone screen, a modal) sit on a sunken surface so they do not
  float naked on the canvas. Full-width mockups (a dashboard, a settings page) need no wrapper.
- No browser chrome, no fake window controls, no drop shadows. The frame is the chrome.
- No icon font is available. If a glyph is genuinely needed, draw a 16px inline SVG with
  stroke="currentColor" fill="none" stroke-width="1.5" — or use a word instead, which is usually
  better.
- Do not invent data. Placeholder names come from the generic set (Alice, Bob, Example Co) and
  emails from example.com.
- Sentence case in every label, heading, button, and column header.

## Checklist

1. Raised cards for objects, sunken tiles for numbers — not both for the same thing.
2. Every colour is a token; every ramp use is a matched fill and text pair.
3. Labels are secondary, values are default, headings are 500 weight and never heavier.
4. No position:fixed anywhere; overlays use the faux viewport.
5. Grids use minmax so a long value cannot push a column past 680px.
6. Data is generic and plausible, never real personal detail.
`;
