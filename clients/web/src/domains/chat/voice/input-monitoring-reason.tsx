import { Info } from "lucide-react";

import { cn } from "@vellumai/design-library/utils/cn";

import { useTranslation } from "@/i18n";
import { useSystemPermissionsState } from "@/runtime/system-permissions";

interface InputMonitoringReasonProps {
  className?: string;
}

/**
 * The one line that says why macOS is about to ask for Input Monitoring.
 *
 * Dropped in beside the invitation to try the voice key, ahead of
 * `askForInputMonitoring()`: the system prompt names the app and nothing
 * else, so this is where the user learns what the grant is for. Draws nothing
 * once the grant is given, and on a host with no system permissions to ask
 * for, so a user who already said yes never reads about a prompt that is
 * not coming.
 */
export function InputMonitoringReason({
  className,
}: InputMonitoringReasonProps) {
  const { t } = useTranslation("chat");
  const { state } = useSystemPermissionsState();
  const status = state?.inputMonitoring.status ?? null;
  if (status === null || status === "granted") {
    return null;
  }
  return (
    <div
      className={cn(
        "flex items-start gap-1 text-body-small-lighter text-[var(--content-quiet)]",
        className,
      )}
    >
      <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span>{t("inputMonitoringReason.body")}</span>
    </div>
  );
}
