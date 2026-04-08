# App Interaction Hooks

When building apps, proactively wire `sendAction` hooks so the assistant stays aware of meaningful user interactions. Two patterns are available:

## Reactive hooks

Reactive hooks trigger an assistant response. Use them for moments where the assistant's input adds value - selections that need explanation, completions worth celebrating, or submissions that benefit from feedback.

```javascript
// User selects a city on a map — assistant can provide insights
window.vellum.sendAction("city_selected", { city: "Tokyo" });

// User submits a form — assistant can confirm and suggest next steps
window.vellum.sendAction("form_submitted", {
  formId: "signup",
  email: "user@example.com",
});

// User completes a level — assistant can congratulate and hint at what's next
window.vellum.sendAction("level_complete", { level: 5, score: 2400 });
```

## Silent hooks

Silent hooks accumulate state without interrupting the user. The state is automatically included as context when the next reactive hook fires.

```javascript
// User navigates to a new tab — no response needed, but assistant should know
window.vellum.sendAction("state_update", {
  currentView: "forecast",
  city: "Tokyo",
});

// Score changes during gameplay — track silently
window.vellum.sendAction("state_update", { score: 1250, lives: 2 });

// User applies a filter — context for future questions
window.vellum.sendAction("state_update", {
  filter: "last-30-days",
  sortBy: "revenue",
});
```

## When to use reactive vs silent

Choose based on whether the assistant's response would genuinely help the user at that moment:

| App type            | Silent (state accumulation)                          | Reactive (triggers response)                               |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| **Dashboards**      | Tab navigation, filter changes, date range selection | Anomaly detected, threshold breached, data export complete |
| **Games**           | Score updates, move tracking, timer ticks            | Level complete, achievement unlocked, game over            |
| **Forms & wizards** | Field focus, partial input, step navigation          | Form submitted, validation failed on submit                |
| **Trackers**        | Incremental progress, status toggles, reordering     | Milestone reached, streak achieved, all items complete     |
| **Data explorers**  | Sorting, paging, column toggling                     | Row selected for detail, comparison initiated              |

Wire hooks during the initial build - don't wait for the user to ask. Apps that communicate state back to the assistant feel alive; apps that don't feel like static pages.
