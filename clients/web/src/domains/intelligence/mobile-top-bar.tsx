/**
 * The two pieces an About Assistant page publishes into the chat header's
 * mobile top bar: the leading back pill and the centered title. Shared by
 * `IntelligenceLayout`, which owns the bar for every section, and by the
 * personality stage, which owns its own, so the row looks the same wherever
 * it is registered from.
 */

import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

import { Button, Typography } from "@vellumai/design-library";

/** The bar's centered title, capped so a long label cannot crowd the pills. */
export function MobileTopBarTitle({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="body-medium-default"
      className="max-w-[50vw] truncate text-[var(--content-secondary)]"
    >
      {children}
    </Typography>
  );
}

interface MobileTopBarBackProps {
  ariaLabel: string;
  tooltip: string;
  /** A fixed destination. Pass this or `onClick`, not both. */
  to?: string;
  /** A destination picked at press time, e.g. pop-or-replace back to a list. */
  onClick?: () => void;
}

/**
 * The bar's back pill. `to` renders a link, since the destination is known up
 * front; `onClick` renders a plain button, so nothing navigates before the
 * handler decides where back goes.
 */
export function MobileTopBarBack({
  ariaLabel,
  tooltip,
  to,
  onClick,
}: MobileTopBarBackProps) {
  return (
    <Button
      shape="pill"
      variant="ghost"
      iconOnly={<ArrowLeft aria-hidden />}
      className="max-md:bg-[var(--surface-active)]"
      aria-label={ariaLabel}
      tooltip={tooltip}
      {...(to != null
        ? { asChild: true, children: <Link to={to} /> }
        : { onClick })}
    />
  );
}
