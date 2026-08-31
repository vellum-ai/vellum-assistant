import { useTranslation } from "@/i18n";
import { Typography } from "@vellumai/design-library/components/typography";

/** The "Plan" title, shared by the resolved plan card and its skeleton. */
export function PlanHeading() {
  const { t } = useTranslation("settings");
  return (
    <Typography
      as="h2"
      variant="title-medium"
      className="text-[var(--content-emphasised)]"
    >
      {t("planCard.heading")}
    </Typography>
  );
}
