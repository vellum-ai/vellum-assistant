import { Button } from "@vellumai/design-library/components/button";
import { RefreshCw } from "lucide-react";

import { useTranslation } from "@/i18n";

interface TunnelRecheckButtonProps {
  /** Re-runs the daemon-side probe. This button owns no fetching of its own. */
  onRefresh: () => void;
  isRefreshing: boolean;
  /**
   * Show the copy beside the icon, for the first-run notice where the button
   * stands on its own. The status row is already a labelled line, so there the
   * same copy is the icon's accessible name instead.
   */
  labelled?: boolean;
}

/**
 * Re-runs the tunnel probe. Two surfaces offer it, the status row and the
 * first-run notice the row draws nothing for, and the two have to stay one
 * affordance: same copy, same spinner, same refusal to fire twice at once.
 */
export function TunnelRecheckButton({
  onRefresh,
  isRefreshing,
  labelled = false,
}: TunnelRecheckButtonProps) {
  const { t } = useTranslation("settings");
  const label = t("tunnelStatusRow.refreshLabel");
  const icon = (
    <RefreshCw className={isRefreshing ? "animate-spin" : undefined} />
  );

  return labelled ? (
    <Button
      variant="outlined"
      size="compact"
      leftIcon={icon}
      disabled={isRefreshing}
      onClick={onRefresh}
    >
      {label}
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="compact"
      iconOnly={icon}
      aria-label={label}
      disabled={isRefreshing}
      onClick={onRefresh}
    />
  );
}
