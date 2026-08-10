import { useTranslation } from "@/i18n";

/**
 * Top-level page header for the home dashboard: the "Activity" title. Sits
 * above the notifications feed. Mirrors the Library page header styling.
 */
export function HomeTopHeader() {
  const { t } = useTranslation("home");

  return (
    <h1 className="shrink-0 text-title-large text-[var(--content-default)]">
      {t("homeTopHeader.title")}
    </h1>
  );
}
