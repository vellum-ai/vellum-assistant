import type { ReactNode } from "react";

import { Card, cn } from "@vellumai/design-library";

export interface DetailCardProps {
  id?: string;
  title?: string;
  subtitle?: string;
  accessory?: ReactNode;
  compactAccessory?: boolean;
  children?: ReactNode;
  showBorder?: boolean;
  variant?: "default" | "danger";
  className?: string;
}

export function DetailCard({
  id,
  title,
  subtitle,
  accessory,
  compactAccessory = false,
  children,
  showBorder = true,
  variant = "default",
  className,
}: DetailCardProps) {
  const hasHeader = Boolean(title || subtitle || accessory);
  const body = (
    <>
      {hasHeader && (
        <div
          className={
            compactAccessory
              ? "flex flex-row items-start justify-between gap-4"
              : "flex flex-col items-start gap-3 md:flex-row md:items-start md:justify-between md:gap-4"
          }
        >
          <div className="flex min-w-0 flex-col gap-2">
            {title && (
              <h2 className="text-title-medium text-[var(--content-emphasised)]">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="text-body-medium-default text-[var(--content-tertiary)]">
                {subtitle}
              </p>
            )}
          </div>
          {accessory && <div className="shrink-0">{accessory}</div>}
        </div>
      )}
      {children != null && (
        <div className={hasHeader ? "mt-4" : ""}>{children}</div>
      )}
    </>
  );

  if (!showBorder) {
    return (
      <section id={id} className={cn("space-y-4", className)}>
        {body}
      </section>
    );
  }

  return (
    <Card
      asChild
      className={cn(
        variant === "danger" &&
          "border-[var(--system-negative-weak)] bg-[var(--surface-lift)]",
        className,
      )}
    >
      <section id={id}>{body}</section>
    </Card>
  );
}
