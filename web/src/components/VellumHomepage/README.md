# HTML to React Conversion Strategy

## Overview

This directory contains the Vellum homepage components. The current implementation loads a large Webflow-exported HTML file (`vellum-homepage.html`, 3589 lines) and injects a React NavBar component via DOM manipulation.

**Goal**: Convert the static HTML to proper React components incrementally to improve maintainability, performance, and developer experience.

## Current Implementation

- **VellumBody.tsx**: Loads HTML from `/public/vellum-homepage.html` and replaces external auth URLs with local routes (`/login`, `/signup`)
- **NavBar.tsx**: React component for the navigation bar, injected into the HTML via a portal
- **Auth link replacement**: Functional and working

## Conversion Strategy: 4 Phases

### Phase 1: Foundation ✅ (COMPLETE)
- [x] NavBar extracted as React component
- [x] Auth link replacement working
- [x] Documentation created (this file)

### Phase 2: Hero & Top Sections (TODO)
Convert the following sections to React components:
- Hero section (main headline, CTA)
- Logo marquee (client logos)
- "Automate" section

**Approach**:
- Extract HTML for each section
- Convert to JSX (handle class→className, style attributes, etc.)
- Preserve all Webflow classes and IDs for styling
- Test that all animations/interactions still work

### Phase 3: Interactive Components (TODO)
Convert complex interactive sections:
- AgentTabs component
- PromptBox with typing effect
- Video/demo sections
- Testimonials carousel

**Approach**:
- Identify JavaScript dependencies (if any)
- Convert to React state management
- Ensure Webflow interactions are preserved or reimplemented

### Phase 4: Footer & Cleanup (TODO)
- Convert footer to React component
- Remove the HTML file entirely
- Optimize bundle size (lazy loading, code splitting)
- Final testing across all breakpoints

## Testing Checklist

For each phase, verify:
- [ ] Layout matches pixel-perfect on all breakpoints (mobile, tablet, desktop)
- [ ] All links work correctly
- [ ] Animations and transitions function as expected
- [ ] No console errors
- [ ] Lighthouse score remains the same or improves

## Component Pattern

Example structure for extracted components:

```tsx
export function HeroSection() {
  return (
    <section className="hero-section">
      {/* Preserved Webflow HTML structure */}
    </section>
  );
}
```

## Notes

- **Why incremental?** The Webflow HTML is complex with many interactions. Converting everything at once risks breaking functionality.
- **Why keep Webflow classes?** Webflow's CSS is tightly coupled to class names. Preserving them ensures styling remains intact.
- **Future optimization**: Once all HTML is converted, we can refactor the CSS and component structure for better maintainability.

## Related Files

- `VellumBody.tsx` - Main component loading HTML
- `NavBar.tsx` - Extracted navigation component
- `/public/vellum-homepage.html` - Source HTML (3589 lines)
- `MarketingPage.tsx` - Similar pattern for other marketing pages
