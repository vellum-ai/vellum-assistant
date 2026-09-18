import { PanelLeft } from "lucide-react";

import { Button, cn } from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";

import { useTranslation } from "@/i18n";

import { useInboxRailHidden } from "../hooks/use-inbox-rail-hidden";

export interface InboxRailRestoreProps {
  /** Match the axis of the surface it sits in. */
  align?: "center" | "start";
}

/**
 * The way back for someone who took the Assistant Inbox entry off the side
 * menu: one line saying it is hidden and one button that returns it. Renders
 * nothing while the entry is showing, so a surface can mount it
 * unconditionally and it only appears for the people it is for.
 */
export function InboxRailRestore({ align = "center" }: InboxRailRestoreProps) {
  const { t } = useTranslation("assistant-inbox");
  const { hidden, restore } = useInboxRailHidden();

  if (!hidden) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-body-small-lighter text-[var(--content-tertiary)]",
        align === "center" ? "justify-center" : "justify-start",
      )}
    >
      <span>{t("inboxRailRestore.hiddenNote")}</span>
      <Button
        variant="ghost"
        size="compact"
        leftIcon={<PanelLeft />}
        onClick={() => {
          restore();
          toast.success(t("inboxRailRestore.restoredToast"));
        }}
      >
        {t("inboxRailRestore.restoreButton")}
      </Button>
    </div>
  );
}
