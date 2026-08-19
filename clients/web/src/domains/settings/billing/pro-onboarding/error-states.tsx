import { AlertCircle } from "lucide-react";

import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import { IconBadge } from "./primitives";
import { takeoverCopy, type TakeoverDirection } from "./takeover-copy";

export function FetchErrorState({
  onGoToBilling,
  direction,
}: {
  onGoToBilling: () => void;
  /** Which way the change whose billing reads failed was going. */
  direction?: TakeoverDirection;
}) {
  const { t } = useTranslation("settings");

  return (
    <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <IconBadge icon={AlertCircle} />
      <div className="space-y-1.5">
        <Typography variant="title-small" as="h1">
          {t("errorStates.fetchErrorTitle")}
        </Typography>
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="text-[var(--content-secondary)]"
        >
          {takeoverCopy(direction).fetchErrorBody}
        </Typography>
      </div>
      <Button
        variant="primary"
        data-testid="onboarding-go-to-billing"
        onClick={onGoToBilling}
      >
        {t("errorStates.goToBilling")}
      </Button>
    </div>
  );
}
