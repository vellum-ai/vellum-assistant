import type { ReactNode } from "react";

import { Card } from "@vellumai/design-library/components/card";

interface IntegrationListRowProps {
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  primaryAction: ReactNode;
  actionMenu?: ReactNode;
}

export function IntegrationListRow({
  icon,
  title,
  subtitle,
  status,
  primaryAction,
  actionMenu,
}: IntegrationListRowProps) {
  return (
    <Card.Root className="@container">
      <Card.Body
        padding="sm"
        className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 px-4 @[28rem]:grid-cols-[2rem_minmax(0,1fr)_auto]"
      >
        {icon}
        <div className="min-w-0 space-y-1">
          <p className="text-title-small text-[var(--content-default)] [overflow-wrap:anywhere]">
            {title}
          </p>
          {subtitle ? (
            <p className="line-clamp-2 text-body-medium-lighter text-[var(--content-tertiary)] [overflow-wrap:anywhere]">
              {subtitle}
            </p>
          ) : null}
          {status}
        </div>
        <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-2 @[28rem]:col-start-3 @[28rem]:row-start-1 [&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal">
          {primaryAction}
          {actionMenu}
        </div>
      </Card.Body>
    </Card.Root>
  );
}
