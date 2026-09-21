/**
 * Small pill flagging that an installed plugin is behind the marketplace
 * pin. Shared by the plugins list row and the plugin detail header so the
 * "update available" affordance reads identically on both surfaces.
 *
 * Pass `onClick` to turn the pill into the Upgrade control (list row); omit
 * it for the static detail-header badge.
 */
import { ArrowUpCircle, Loader2 } from "lucide-react";
import { createElement } from "react";

import { useTranslation } from "@/i18n";
import { Chip, Tag } from "@vellumai/design-library";

interface UpdateAvailableBadgeProps {
  /**
   * When provided the pill becomes an interactive Upgrade control: clicking it
   * triggers the upgrade and stops the click from selecting the row it sits in.
   */
  onClick?: () => void;
  /** Swap the icon for a spinner and disable the control while upgrading. */
  isUpgrading?: boolean;
}

export function UpdateAvailableBadge({
  onClick,
  isUpgrading = false,
}: UpdateAvailableBadgeProps = {}) {
  const { t } = useTranslation("intelligence");
  const icon = createElement(isUpgrading ? Loader2 : ArrowUpCircle, {
    className: isUpgrading ? "animate-spin" : undefined,
  });
  const label = t("updateAvailableBadge.updateAvailable");

  if (!onClick) {
    return (
      <Tag tone="warning" leftIcon={icon} className="shrink-0">
        {label}
      </Tag>
    );
  }

  return (
    <Chip
      tone="warning"
      leftIcon={icon}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={isUpgrading}
      aria-label={t("updateAvailableBadge.upgradePluginAriaLabel")}
      className="shrink-0"
    >
      {label}
    </Chip>
  );
}
