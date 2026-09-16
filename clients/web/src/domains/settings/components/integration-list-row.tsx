import type { ReactNode } from "react";

import { Card } from "@vellumai/design-library/components/card";

export type IntegrationListLayout = "row" | "tile";

interface IntegrationListRowProps {
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  primaryAction: ReactNode;
  actionMenu?: ReactNode;
  layout?: IntegrationListLayout;
}

export function IntegrationListRow({
  icon,
  title,
  subtitle,
  status,
  primaryAction,
  actionMenu,
  layout = "row",
}: IntegrationListRowProps) {
  if (layout === "tile") {
    return (
      <Card.Root
        bordered
        className="group flex h-full flex-col gap-3 transition-colors hover:border-[var(--border-hover)]"
      >
        <div className="flex items-start justify-between gap-2">
          {icon}
          <div className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:pointer-coarse:min-h-11">
            {primaryAction}
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <p className="truncate text-title-small text-[var(--content-default)]">
            {title}
          </p>
          {subtitle ? (
            <p className="line-clamp-2 text-body-small-lighter text-[var(--content-tertiary)] [overflow-wrap:anywhere]">
              {subtitle}
            </p>
          ) : null}
        </div>
      </Card.Root>
    );
  }

  return (
    <Card.Root className="@container">
      <Card.Body
        padding="sm"
        className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 px-4 @[28rem]:grid-cols-[2rem_minmax(0,1fr)_auto]"
      >
        {icon}
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-title-small text-[var(--content-default)] [overflow-wrap:anywhere]">
              {title}
            </p>
            {status}
          </div>
          {subtitle ? (
            <p className="line-clamp-2 text-body-medium-lighter text-[var(--content-tertiary)] [overflow-wrap:anywhere]">
              {subtitle}
            </p>
          ) : null}
        </div>
        <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-2 @[28rem]:col-start-3 @[28rem]:row-start-1 [&_button]:max-w-full [&_button]:min-h-11 [&_button]:whitespace-normal">
          {primaryAction}
          {actionMenu}
        </div>
      </Card.Body>
    </Card.Root>
  );
}
