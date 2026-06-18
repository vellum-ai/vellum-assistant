# Widget Component Library

A CSS widget library is auto-injected alongside the design system — the `.v-*` classes below. Use these for standard UI patterns; skip them when custom HTML serves the user better. (The JavaScript helpers historically listed here are **not currently available** — see the section below.)

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
| `.v-toast`                                                   | Notification banner (show/hide with your own JS)              |
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

| Widget                                           | Purpose                                                |
| ------------------------------------------------ | ------------------------------------------------------ |
| `.v-hero` / `.v-hero-badge` / `.v-hero-subtitle` | Hero banner with gradient, trust badge, accent word    |
| `.v-section-header` / `.v-section-label`         | Section intro with label                               |
| `.v-feature-grid` / `.v-feature-card`            | Feature showcase with hover lift                       |
| `.v-pullquote`                                   | Blockquote with gradient accent border                 |
| `.v-comparison`                                  | Before/after cards (`.before`/`.after`)                |
| `.v-page`                                        | Centered flex-column container (fills available width) |
| `.v-gradient-text`                               | Accent-colored gradient text                           |
| `.v-animate-in`                                  | Staggered fade-in for children                         |

## JavaScript utilities — NOT currently available

> ⚠️ **`window.vellum.widgets.*` is not injected today. Do not call it — these functions are `undefined` at runtime and will throw.** The same applies to `window.vellum.confirm`, `window.vellum.openLink`, and `window.vellum.theme`. The only `window.vellum` APIs that exist are `sendAction`, `fetch`, and `route` (see [`INTERACTION_HOOKS.md`](./INTERACTION_HOOKS.md)).
>
> Until a JS runtime ships, build these by hand:
> - **Charts** → hand-written inline SVG (or simple CSS bars), sized to the container to avoid overflow.
> - **Notifications** → the `.v-toast` class, toggled with your own JS.
> - **Table sort/filter, tabs, accordions, countdowns** → plain JS event handlers.
> - **Formatting** → `Intl.NumberFormat` / `Intl.DateTimeFormat`.
> - **Theme** → `@media (prefers-color-scheme: dark)` in CSS (don't read `window.vellum.theme`).

## When to use the CSS widgets vs custom HTML

- **Use the CSS widget classes** for standard patterns — tables, metrics, timelines, notifications.
- **Use custom HTML** for novel or creative UIs — games, art tools, unique dashboards.
- **Mix freely** — the classes compose well together and with custom elements.
