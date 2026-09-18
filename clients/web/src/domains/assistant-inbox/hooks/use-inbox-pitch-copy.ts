import { useTranslation } from "@/i18n";

export interface InboxPitchCopy {
  title: string;
  subtitle: string;
}

/**
 * The title and supporting line of the managed-email pitch, from this
 * domain's own catalog. A hook rather than two keys for callers to read, so
 * a surface in another domain (the Channels page's Email section, which sets
 * these as its header) gets the copy without reaching into this namespace,
 * and the named and nameless titles stay one decision made in one place.
 */
export function useInboxPitchCopy(assistantName: string): InboxPitchCopy {
  const { t } = useTranslation("assistant-inbox");
  return {
    title: assistantName
      ? t("assistantInboxUpgradeState.title", { name: assistantName })
      : t("assistantInboxUpgradeState.titleNoName"),
    subtitle: t("assistantInboxUpgradeState.subtitle"),
  };
}
