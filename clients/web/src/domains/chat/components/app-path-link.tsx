/**
 * Markdown link to a client route. Navigates in place (no new tab, no
 * external-link glyph) so a conversation or schedule href stays inside the
 * app the way a work-result item link does.
 */

import type { ReactNode } from "react";
import { Link } from "react-router";

import { EXTERNAL_LINK_CLASS } from "@/components/external-anchor";

export function AppPathLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link to={href} className={EXTERNAL_LINK_CLASS}>
      {children}
    </Link>
  );
}
