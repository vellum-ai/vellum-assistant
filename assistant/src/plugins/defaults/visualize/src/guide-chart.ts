/** Guidance for the `chart` module of `visualize_guide`: hand-rolled SVG charts. */
export const CHART_GUIDE = `# Module: chart

Charts are drawn by hand in SVG. There is no charting library in the sandbox — no Chart.js, no D3,
no plotting CDN. This is less work than it sounds: a bar or line chart is a scale function and a
loop.

## Pick the mark

- Bar — comparing a handful of named categories. Horizontal bars when the labels are long.
- Grouped bar — the same categories across two or three series. Three series is the ceiling.
- Line — a value over ordered time. Two or three series maximum, each labelled at its right end
  rather than in a legend.
- Area — a single cumulative quantity over time. Never stack more than two.
- Donut or stacked bar — parts of one whole, four slices maximum. If you have more, the answer is a
  bar chart sorted descending.
- Sparkline — a trend inline next to a number, no axes.

Do not draw a chart for three numbers. A metric tile row or a sentence carries them better.

## Frame

    <svg width="100%" viewBox="0 0 680 280" role="img">
      <title>Monthly active users, January to June</title>
      <desc>A bar chart rising from 8,200 in January to 12,480 in June.</desc>
      <style>
        text{font-family:var(--font-sans)}
        .lbl{font-size:12px;fill:var(--content-secondary)}
        .val{font-size:12px;fill:var(--content-strong)}
        .grid{stroke:var(--border-base);stroke-width:1}
        .axis{stroke:var(--border-element);stroke-width:1}
      </style>
      ...
    </svg>

Plot area convention: left margin 48 (room for value labels), right margin 16, top margin 16,
bottom margin 32 (room for category labels). So the plot spans x 48 to 664 and y 16 to (height
minus 32). Keep viewBox width at 680.

## Scaling

Compute the domain and write the mapping down before drawing anything.

    const max = Math.max(...data.map(d => d.v));
    const nice = Math.ceil(max / 1000) * 1000;
    const y = v => plotBottom - (v / nice) * (plotBottom - plotTop);

Round the top of the scale up to a clean number (a 1, 2, or 5 times a power of ten). Bar charts
always start at zero — a truncated baseline exaggerates differences and is dishonest. Line charts
may start above zero when the variation is small relative to the level; say so in the axis labels.

## Bars

    <rect x="72" y="96" width="56" height="128" rx="2" fill="var(--color-forest-600)"/>
    <text class="lbl" x="100" y="248" text-anchor="middle">Jan</text>

- Bar width: (plot width / count) times 0.6, with the remaining 0.4 as the gap.
- rx="2". Larger rounding on a thin bar looks like a mistake.
- One colour for one series. Reach for a second ramp only when a bar means something different
  (a projection, a threshold breach) — and then say what in a one-line legend.
- Label values directly above or inside the bars when there are six or fewer; drop the y axis
  entirely when you do. Direct labels beat an axis the eye has to travel to.

## Lines

    <polyline fill="none" stroke="var(--color-forest-600)" stroke-width="2" stroke-linejoin="round" points="48,180 172,150 296,160 420,110 544,96 664,72"/>

- fill="none" is mandatory on every polyline and path. Without it SVG fills the shape black.
- stroke-width 2 for the line, 1 for gridlines and axes.
- Points at 3px radius, and only when there are eight or fewer.
- Label each series at its right end in the series colour rather than adding a legend box.
- For an area, close the path back along the baseline and fill with the 200 stop of the same ramp
  at full opacity — not with transparency.

## Axes and gridlines

- Horizontal gridlines only, at three or four values, in --border-base. No vertical gridlines, no
  chart border, no background fill.
- Draw the baseline (the zero line) in --border-element so it reads as the axis.
- Axis labels 12px in --content-secondary; the value labels you actually want read in
  --content-strong.
- Format tick labels compactly: 12k rather than 12,000, one decimal maximum. Units go once, in the
  first tick or the description, not on every label.
- Rotated tick labels are not allowed. If category names do not fit, switch to horizontal bars.

## Donut

    <circle cx="120" cy="120" r="56" fill="none" stroke="var(--color-moss-200)" stroke-width="18"/>
    <circle cx="120" cy="120" r="56" fill="none" stroke="var(--color-forest-600)" stroke-width="18" stroke-dasharray="214 352" transform="rotate(-90 120 120)"/>

Circumference is 2 times pi times r; the dash length is that times the fraction. Put the headline
percentage in the middle at 24px weight 500. Four segments maximum, each with a labelled swatch to
the right.

## Numbers

Every value printed on a chart goes through toLocaleString, toFixed, or Math.round. Percentages get
at most one decimal. Currency gets a symbol and thousands separators. A chart showing
30.000000000000004% destroys trust in everything around it.

## Honesty rules

- Bars start at zero, always.
- Do not interpolate between points you do not have. Gaps stay gaps.
- Label the units and the period. A chart of "revenue" with no time range is not an answer.
- If the data is estimated or partial, say so in your prose — never inside the chart.

## Checklist

1. Every polyline and path has fill="none".
2. The scale top is a round number and bars start at zero.
3. Three or four gridlines, no vertical grid, no chart border.
4. Every label is sentence case, 12px minimum, unrotated.
5. Colours are tokens; one ramp per series, two ramps maximum.
6. viewBox height equals the lowest element plus 24, and everything sits inside x 0 to 680.
`;
