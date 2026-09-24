import type { ReactNode } from "react";
import { CircleAlert, Ellipsis } from "lucide-react";
import { cn, Typography } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

export interface AllChatsActivityBadgeProps {
  status: "running" | "attention";
  count: number;
  children?: ReactNode;
}

export function AllChatsActivityBadge({
  status,
  count,
  children,
}: AllChatsActivityBadgeProps) {
  const { t } = useTranslation("chat");
  const attention = status === "attention";
  const description = attention
    ? t("allChatsPage.needsAttention")
    : t("allChatsPage.runningCount", { count });
  return (
    <span
      role="status"
      aria-label={description}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--border-base)] px-1.5 py-0.5",
        attention
          ? "text-[var(--system-mid-strong)]"
          : "text-[var(--content-secondary)]",
      )}
    >
      <span className="sr-only">{description}</span>
      {attention ? (
        <CircleAlert size={12} aria-hidden />
      ) : (
        <Ellipsis size={12} aria-hidden className="motion-safe:animate-pulse" />
      )}
      <Typography
        variant="body-small-lighter"
        className="max-sm:hidden"
        aria-hidden
      >
        {attention
          ? t("allChatsPage.needsAttention")
          : t("allChatsPage.running")}
      </Typography>
      <span className="hidden sm:contents" aria-hidden>
        {children}
      </span>
    </span>
  );
}
