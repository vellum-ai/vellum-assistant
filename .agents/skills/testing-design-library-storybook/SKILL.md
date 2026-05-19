---
name: testing-design-library-storybook
description: Guide for testing design library components in Storybook. Covers theme switching, iframe DOM access, data-slot verification, and Radix Slot caveats.
---

# Testing Design Library Components in Storybook

## Starting Storybook

```bash
cd packages/design-library && bun run storybook
```

Storybook runs on `http://localhost:6006`.

## Theme Switching

The Storybook toolbar has a paintbrush icon for theme selection (Light / Dark / Velvet). Use this to verify design tokens resolve correctly per theme. The theme is applied via `data-theme` attribute on the preview container.

## Accessing Story DOM

Storybook renders stories inside an iframe (`#storybook-preview-iframe`). To query elements via browser console:

```js
const iframe = document.querySelector('#storybook-preview-iframe');
const doc = iframe.contentDocument;
doc.querySelectorAll('[data-slot]'); // Find all data-slot elements
```

## Verifying data-slot Attributes

Per AGENTS.md rule 2, every component root element needs a `data-slot` attribute. To verify:

```js
const iframe = document.querySelector('#storybook-preview-iframe');
const doc = iframe.contentDocument;
const slots = doc.querySelectorAll('[data-slot]');
slots.forEach(el => console.log(el.tagName, el.getAttribute('data-slot')));
```

### Radix Slot + asChild Caveat

When a Radix wrapper component (e.g. `Popover.Trigger`) uses `asChild` with a child that has its own `data-slot` (e.g. `<Button>`), the **child's `data-slot` takes precedence**. This is expected Radix Slot merge behavior — child props win for same-named attributes.

Example: `<Popover.Trigger data-slot="popover-trigger" asChild><Button data-slot="button">` renders as `data-slot="button"` on the final element.

The wrapper's `data-slot` IS correctly set in the component code — it just won't be visible in the DOM when `asChild` delegates to a component with its own `data-slot`. Without `asChild`, the wrapper renders its own element and the `data-slot` appears normally.

## Test Checklist for New Components

1. Component renders with correct visual styling (background, shadow, borders)
2. Interactive behaviors work (open/close, dismiss, click handlers)
3. All positioning variants render correctly (if applicable)
4. Theme switching changes appearance (tokens resolve in portal if portaled)
5. `data-slot` attributes present on all DOM-rendering parts
6. Accessibility panel shows no critical violations
