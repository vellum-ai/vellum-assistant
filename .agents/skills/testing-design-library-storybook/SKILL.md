---
name: testing-design-library-storybook
description: Test the design library Storybook setup end-to-end. Use when verifying theme switching, CSS design tokens, or component rendering in Storybook.
---

# Testing Design Library Storybook

## Prerequisites

- Bun installed (`export PATH="$HOME/.bun/bin:$PATH"`)
- The `packages/design-library/` directory exists with Storybook configured

## Starting Storybook

```bash
cd packages/design-library
export PATH="$HOME/.bun/bin:$PATH"
bun install
bun run storybook
```

Storybook runs on port 6006 by default. If that port is in use, it will prompt for an alternative (typically 6007). Accept the prompt or kill the existing process on 6006.

## Key Test Flows

### Theme Switching (Primary Flow)

The design library supports three themes: **Light**, **Dark**, and **Velvet**. The theme switcher is in the Storybook toolbar (paintbrush icon with theme name).

1. Navigate to `http://localhost:6006/?path=/story/components-button--primary`
2. Click the theme dropdown in the toolbar
3. Switch between Light → Dark → Velvet
4. Verify:
   - **Light**: Button bg is dark `rgb(23, 25, 28)`, canvas is light `rgb(246, 245, 244)`
   - **Dark**: Button bg inverts to white `rgb(253, 253, 252)`, canvas is dark
   - **Velvet**: Button bg is red/pink `rgb(232, 63, 91)`, canvas is very dark `rgb(18, 18, 20)`

### Verifying CSS Token Values

Use browser console to verify exact computed styles:

```javascript
const iframe = document.querySelector('#storybook-preview-iframe');
const doc = iframe.contentDocument;
const btn = doc.querySelector('.vdl-btn-primary');
const style = getComputedStyle(btn);
console.log('bg:', style.backgroundColor);
console.log('color:', style.color);
console.log('theme:', doc.documentElement.getAttribute('data-theme'));
```

Note: The Storybook preview renders inside an iframe (`#storybook-preview-iframe`). You must access `iframe.contentDocument` to inspect component styles. The first few `<button>` elements in the iframe may be Storybook UI buttons (e.g., "Set string"), not the component under test — use `.vdl-btn-primary` or `[data-slot="notice"]` selectors to target actual components.

### Notice Component Tones

Navigate to Notice > All Tones story. Verify each tone (info, success, warning, error, neutral) has a distinct background color that changes with theme:

```javascript
const notices = doc.querySelectorAll('[data-slot="notice"]');
notices.forEach((n, i) => {
  console.log(`notice[${i}] bg=${getComputedStyle(n).backgroundColor}`);
});
```

## Architecture Notes

- Tokens live in `src/tokens.css` — single source of truth for all three themes
- Theme switching works via `data-theme` attribute on document root (set by Storybook decorator in `.storybook/preview.ts`)
- CSS selectors: `:root` (light), `[data-theme="dark"]`, `[data-theme="velvet"]`
- The `@custom-variant dark` directive wires Tailwind's `dark:` prefix to `data-theme="dark"`
- The `@theme inline` block bridges CSS variables to Tailwind utility classes

## Common Issues

- **Port conflict**: Storybook may prompt to use a different port if 6006 is occupied. Accept or `lsof -ti:6006 | xargs kill` first.
- **Styles not loading**: If components appear unstyled, verify `src/tokens.css` is imported in `.storybook/preview.css` and that `@tailwindcss/vite` is configured in `.storybook/main.ts`.
- **Theme not switching**: Check that the decorator in `preview.ts` sets `data-theme` on both `document.documentElement` and `document.body`.

## CI Checks

```bash
cd packages/design-library
bunx tsc --noEmit          # Type check
bun run build-storybook    # Build check
bun run lint               # Lint (if configured)
```
