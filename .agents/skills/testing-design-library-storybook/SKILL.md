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

**Important:** Test theme switching in BOTH canvas mode AND docs mode — they use different rendering pipelines.

#### Canvas Mode
1. Navigate to `http://localhost:6006/?path=/story/components-button--primary`
2. Click the theme dropdown in the toolbar
3. Switch between Light → Dark → Velvet
4. Verify:
   - **Light**: Button bg is dark `rgb(23, 25, 28)`, canvas is light `rgb(246, 245, 244)`
   - **Dark**: Button bg inverts to white `rgb(253, 253, 252)`, canvas is dark
   - **Velvet**: Button bg is red/pink `rgb(232, 63, 91)`, canvas is very dark `rgb(18, 18, 20)`

#### Docs Mode
1. Navigate to `http://localhost:6006/?path=/docs/components-button--docs`
2. Click the theme dropdown in the toolbar
3. Switch between Light → Dark → Velvet
4. Verify:
   - **Docs page background** changes (not just the story preview area)
   - **Heading text** ("button") switches between dark/light
   - **Prop table** text, labels, and borders are all readable against the background
   - **Story preview boxes** within docs also update
5. Verify on a second component (e.g., Notice docs) to confirm cross-component theming

Docs mode theming is handled by a custom `ThemedDocsContainer` in `.storybook/preview.tsx` that maps the theme global to a Storybook theme object, which cascades via ThemeProvider to all emotion-styled docs elements.

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

### ResizablePanel Drag Testing

Native mouse drag (via `left_click_drag`) does NOT work across Storybook's iframe boundary. Use dispatched PointerEvents instead:

```javascript
const iframe = document.querySelector('#storybook-preview-iframe');
const doc = iframe.contentDocument;
const separator = doc.querySelector('[role="separator"]');
const rect = separator.getBoundingClientRect();
const startX = rect.left + rect.width / 2;
const startY = rect.top + rect.height / 2;

separator.dispatchEvent(new PointerEvent('pointerdown', {
  clientX: startX, clientY: startY, bubbles: true, pointerId: 1,
  isPrimary: true, button: 0, buttons: 1
}));

separator.dispatchEvent(new PointerEvent('pointermove', {
  clientX: startX + 100, clientY: startY, bubbles: true, pointerId: 1,
  isPrimary: true, button: 0, buttons: 1
}));

separator.dispatchEvent(new PointerEvent('pointerup', {
  clientX: startX + 100, clientY: startY, bubbles: true, pointerId: 1,
  isPrimary: true, button: 0
}));

const panel = doc.querySelector('[data-slot="resizable-panel"]');
const leftPane = panel.children[0];
console.log('left pane width:', leftPane.getBoundingClientRect().width);
```

Key points:
- Include `isPrimary: true`, `button: 0`, `buttons: 1` — the component may check these.
- The component uses `setPointerCapture`, so dispatch events directly on the separator element.
- Verify width changes via `getBoundingClientRect()` before and after.

### Notice Component Tones

Navigate to Notice > All Tones story. Verify each tone (info, success, warning, error, neutral) has a distinct background color that changes with theme:

```javascript
const notices = doc.querySelectorAll('[data-slot="notice"]');
notices.forEach((n, i) => {
  console.log(`notice[${i}] bg=${getComputedStyle(n).backgroundColor}`);
});
```

## Verifying Storybook Version

The bottom-left corner may show a "Storybook 10.x" marketing notification that does NOT reflect the actual running version. To verify the real version:

```bash
cat packages/design-library/node_modules/storybook/package.json | grep '"version"'
```

## Architecture Notes

- Tokens live in `src/tokens.css` — single source of truth for all three themes
- Theme switching works via `data-theme` attribute on document root (set by Storybook decorator in `.storybook/preview.tsx`)
- CSS selectors: `:root` (light), `[data-theme="dark"]`, `[data-theme="velvet"]`
- The `@custom-variant dark` directive wires Tailwind's `dark:` prefix to `data-theme="dark"`
- The `@theme inline` block bridges CSS variables to Tailwind utility classes
- **Docs mode uses two theming systems in parallel:**
  1. CSS variables via `data-theme` attribute — for component styling (buttons, notices, etc.)
  2. Storybook's ThemeProvider via `ThemedDocsContainer` — for docs chrome (wrapper bg, text, prop tables, code blocks)
  Both must be in sync for docs mode to look correct.

## Common Issues

- **Port conflict**: Storybook may prompt to use a different port if 6006 is occupied. Accept or `lsof -ti:6006 | xargs kill` first.
- **Styles not loading**: If components appear unstyled, verify `src/tokens.css` is imported in `.storybook/preview.css` and that `@tailwindcss/vite` is configured in `.storybook/main.ts`.
- **Theme not switching**: Check that the decorator in `preview.tsx` sets `data-theme` on both `document.documentElement` and `document.body`.
- **Docs background stuck on white**: If docs page background stays white when switching to dark/velvet, the `ThemedDocsContainer` in `preview.tsx` may not be correctly reading the theme global or mapping it to a Storybook theme. Check `parameters.docs.container` is set.
- **Drag not working**: Native mouse drag does not cross iframe boundaries. Use the dispatched PointerEvent approach above.
- **Story file errors after merge**: If Storybook shows ENOENT errors for story files, the working tree may be out of sync. Run `git pull` and restart Storybook.

## CI Checks

```bash
cd packages/design-library
bunx tsc --noEmit          # Type check
bun run build-storybook    # Build check
bun run lint               # Lint (if configured)
```
