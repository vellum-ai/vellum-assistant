import { routes } from "@/lib/routes";

/**
 * CTA button rendered in the docs header, to the right of the theme picker.
 * Always links to signup; the docs app has no auth-state awareness.
 */
export function DocsNavCta() {
  return (
    <a href={routes.signup} className="docs-nav-cta">
      Sign Up
    </a>
  );
}
