# Vellum Homepage Components

This directory contains React components for rendering the Vellum.ai homepage.

## Current Structure

### Phase 1: Component Extraction (✅ Complete)

- **VellumHead.tsx** - Loads Webflow CSS, fonts, and core scripts
- **VellumScripts.tsx** - Handles tracking scripts (GA, GTM, CleverTap, Athena, etc.)
- **UTMTracker.tsx** - Tracks UTM parameters and referral sources
- **VellumBody.tsx** - Renders the main page content

### Architecture

The homepage is built from Webflow-generated HTML. We've structured it as follows:

1. **Server Components** (VellumHead): Handles SEO metadata and initial styles
2. **Client Components** (VellumScripts, UTMTracker, VellumBody): Handle interactivity and tracking
3. **Static HTML**: The body content is currently served as-is from `/public/vellum-homepage.html`

## Future Improvements

### Phase 2: Incremental Component Conversion

The body content (currently in `VellumBody.tsx`) can be incrementally broken down into proper React components:

**Priority 1:**

- [ ] Extract navigation bar into `NavBar.tsx`
- [ ] Extract hero section into `Hero.tsx`
- [ ] Extract footer into `Footer.tsx`

**Priority 2:**

- [ ] Convert product dropdown sections to `ProductDropdown.tsx`
- [ ] Convert solution sections to `SolutionSection.tsx`
- [ ] Extract CTA sections into reusable `CallToAction.tsx`

**Priority 3:**

- [ ] Convert inline SVGs to React components
- [ ] Replace Webflow CSS classes with Tailwind
- [ ] Add proper TypeScript types for all components
- [ ] Implement proper image optimization with Next.js Image
- [ ] Add accessibility improvements (ARIA labels, keyboard nav)

### Phase 3: Performance Optimization

- [ ] Lazy load below-the-fold content
- [ ] Optimize image loading
- [ ] Code-split large components
- [ ] Remove unused Webflow CSS

## Development Notes

- **Webflow Classes**: The HTML uses Webflow's auto-generated class names. These are tied to their CSS framework, so converting requires careful handling.
- **Tracking Scripts**: All tracking is isolated in `VellumScripts.tsx` for easy management.
- **UTM Tracking**: The UTM logic is complex but fully isolated in `UTMTracker.tsx`.

## Contributing

When converting sections to React components:

1. Start with a small, self-contained section
2. Extract HTML → JSX conversion
3. Move inline styles to CSS modules or Tailwind
4. Add TypeScript types
5. Test that functionality remains identical
6. Update this README with progress

## Questions?

See the main project README or ask in #dev-questions.
