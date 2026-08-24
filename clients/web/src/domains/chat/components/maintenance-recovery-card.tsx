import { WrenchIcon } from "lucide-react";
import { useTranslation } from "@/i18n";

import { Link } from "react-router";

import { routes } from "@/utils/routes";

/**
 * In-chat card shown in place of the empty state when the assistant is in
 * maintenance/recovery mode. Tells the user chat is unavailable and links
 * to the debug settings terminal so they can take recovery actions
 * (restart, view logs, etc.).
 *
 * Pure presentational — visibility is owned by the parent based on
 * `assistantState.maintenanceMode?.enabled`. Rendered inside the
 * scrollable messages area, not as a modal/banner.
 */
export function MaintenanceRecoveryCard() {
  const { t } = useTranslation("chat");
  return (
    <div className="py-12 text-center">
      <WrenchIcon className="mx-auto mb-3 h-8 w-8 text-[var(--system-mid-strong)]" />
      {/* typography: off-scale — 18px text-lg promoted to title-medium (20/500) per canonical mapping. */}
      <h2 className="text-title-medium text-[var(--content-default)]">
        {t("maintenanceRecoveryCard.title")}
      </h2>
      <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
        {t("maintenanceRecoveryCard.body")}
      </p>
      <Link
        to={`${routes.settings.debug}?tab=terminal`}
        className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-[var(--system-mid-strong)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-small-default text-[var(--system-mid-strong)] transition-colors hover:bg-[var(--system-mid-weak)]"
      >
        {t("maintenanceRecoveryCard.goToDebug")}
      </Link>
    </div>
  );
}
