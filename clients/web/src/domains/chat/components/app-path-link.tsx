/**
 * Markdown link to a client route. Navigates in place (no new tab, no
 * external-link glyph) so a conversation or schedule href stays inside the
 * app the way a work-result item link does.
 */

import type { ReactNode } from "react";
import { Link } from "react-router";

import { TextLink } from "@vellumai/design-library/components/text-link";

export function AppPathLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <TextLink asChild>
      <Link to={href}>{children}</Link>
    </TextLink>
  );
}
