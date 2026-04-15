# Widget Component Library

A CSS/JS widget library is auto-injected alongside the design system. Use these for standard UI patterns - skip them when custom HTML serves the user better.

## Layout widgets

| Widget                                                       | Purpose                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| `.v-metric-card` (`.v-metric-grid`)                          | Big number with emoji icon, label, trend                       |
| `.v-data-table`                                              | Sortable table with sticky header, `th[data-sortable]`         |
| `.v-tabs` / `.v-tab-bar` / `.v-tab-panel`                    | Tab navigation with keyboard support                           |
| `.v-accordion` / `.v-accordion-item`                         | Collapsible sections                                           |
| `.v-search-bar`                                              | Search input with clear button                                 |
| `.v-empty-state`                                             | No-data placeholder with CTA                                   |
| `.v-timeline` / `.v-timeline-entry`                          | Vertical timeline (`.active`/`.success`/`.error`)              |
| `.v-action-list` / `.v-action-list-item`                     | Rows with per-item actions                                     |
| `.v-card-grid`                                               | Responsive card grid                                           |
| `.v-progress-bar` / `.v-progress-track` / `.v-progress-fill` | Horizontal progress                                            |
| `.v-status-badge`                                            | Colored pill with dot (`.success`/`.error`/`.warning`/`.info`) |
| `.v-stat-row` / `.v-stat`                                    | Horizontal label-value pairs                                   |
| `.v-toast`                                                   | Notification banner - prefer `vellum.widgets.toast()`          |
| `.v-avatar-row`                                              | Contact/team display                                           |
| `.v-tag-group`                                               | Wrapping tag row                                               |

## Domain-specific widgets

| Widget             | Purpose                |
| ------------------ | ---------------------- |
| `.v-weather-card`  | Temperature + forecast |
| `.v-stock-ticker`  | Price display + chart  |
| `.v-flight-card`   | Flight info with route |
| `.v-billing-chart` | Usage/billing display  |
| `.v-boarding-pass` | Pass-styled layout     |
| `.v-itinerary`     | Day-by-day travel plan |
| `.v-receipt`       | Receipt layout         |
| `.v-invoice`       | Formal invoice         |

## Content & landing page components

| Widget                                           | Purpose                                             |
| ------------------------------------------------ | --------------------------------------------------- |
| `.v-hero` / `.v-hero-badge` / `.v-hero-subtitle` | Hero banner with gradient, trust badge, accent word |
| `.v-section-header` / `.v-section-label`         | Section intro with label                            |
| `.v-feature-grid` / `.v-feature-card`            | Feature showcase with hover lift                    |
| `.v-pullquote`                                   | Blockquote with gradient accent border              |
| `.v-comparison`                                  | Before/after cards (`.before`/`.after`)             |
| `.v-page`                                        | Centered container (max-width 600px)                |
| `.v-gradient-text`                               | Accent-colored gradient text                        |
| `.v-animate-in`                                  | Staggered fade-in for children                      |

## Widget JavaScript utilities

Interactive utilities at `window.vellum.widgets.*`:

### Charts

Always use these instead of hand-coding SVG/CSS charts:

```javascript
vellum.widgets.sparkline("container-id", [10, 25, 15, 30], {
  width: 200,
  height: 40,
  color: "var(--v-success)",
  strokeWidth: 2,
  fill: true,
});
vellum.widgets.barChart(
  "container-id",
  [
    { label: "Jan", value: 120 },
    { label: "Feb", value: 180, color: "var(--v-success)" },
  ],
  {
    width: 400,
    height: 200,
    showLabels: true,
    showValues: true,
    horizontal: false,
  },
);
vellum.widgets.lineChart(
  "container-id",
  [
    { label: "Mon", value: 42 },
    { label: "Tue", value: 58 },
  ],
  { width: 400, height: 200, showDots: true, showGrid: true, gridLines: 4 },
);
vellum.widgets.progressRing("container-id", 75, {
  size: 100,
  strokeWidth: 8,
  color: "var(--v-success)",
  label: "75%",
});
```

### Data Formatting

```javascript
vellum.widgets.formatCurrency(1234.56, "USD"); // "$1,234.56"
vellum.widgets.formatDate("2025-01-15", "relative"); // "3d ago"
vellum.widgets.formatDate("2025-01-15", "short"); // "1/15/25"
vellum.widgets.formatNumber(1234567, { compact: true }); // "1.2M"
```

### Interactive Behaviors

```javascript
vellum.widgets.sortTable("table-id"); // Wire th[data-sortable] click-to-sort
vellum.widgets.filterTable("table-id", "input-id"); // Live text search
vellum.widgets.tabs("tabs-id"); // Tab switching + keyboard nav
vellum.widgets.accordion("accordion-id", { allowMultiple: true });
vellum.widgets.multiSelect("table-id"); // Checkboxes + select-all
vellum.widgets.toast("Saved!", "success", 4000); // Auto-dismiss notification
vellum.widgets.countdown("timer-el", "2025-12-31T00:00:00Z", {
  onComplete: () => {},
});
```

## When to use widgets vs custom HTML

- **Use widgets** for standard patterns - tables, metrics, timelines, notifications
- **Use custom HTML** for novel or creative UIs - games, art tools, unique dashboards
- **Mix freely** - widgets compose well together and with custom elements
- **ALWAYS use `vellum.widgets.*` chart functions** instead of hand-coding SVG/CSS charts. They handle overflow clipping, bounds, scaling, and dark mode. Hand-coded charts break layouts.
