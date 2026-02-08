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

### Phase 2: Hero & Top Sections ✅ (COMPLETE)
Convert the following sections to React components:
- [x] Hero section (main headline, CTA)
- [x] Logo marquee (client logos)
- [x] "Automate" section

**Completed**:
- Extracted Hero section with JUST LAUNCHED tag, headline, and prompt input box
- Extracted Logo Marquee with company logos and case study links
- Extracted Automate section with tab interface (simplified for now)
- All components use React portals to replace HTML sections
- Preserved all Webflow classes and data-w-id attributes for animations
- Auth link replacement working for /login and /signup routes

**Files Created**:
- `HeroSection.tsx` - Main hero with headline and prompt box
- `LogoMarquee.tsx` - Scrolling company logos section
- `AutomateSection.tsx` - "Hey Vellum, automate my" section
- Updated `VellumBody.tsx` to use portals for all Phase 2 components

**Note**: Full interactive functionality for tabs and animations will be enhanced in Phase 3

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
