/**
 * Settings entry point for the iOS home-screen icon.
 *
 * The prompt asks once per avatar and takes no for an answer; this card is
 * where a user who said no, or who changed their mind later, goes. It is
 * therefore the only surface that ignores the decline memory, and the only way
 * back to the default icon: nothing in this feature resets an icon on its own,
 * so an avatar switched to an uploaded image leaves the old icon in place
 * until someone presses Reset here.
 *
 * Draws nothing at all off native iOS, with the `ios-avatar-app-icon` flag
 * off, or on a build that ships no alternate icons.
 */
import { useState } from "react";

import { DetailCard } from "@/components/detail-card";
import { useAppIconSync } from "@/hooks/use-app-icon-sync";
import { useTranslation } from "@/i18n";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { isAvatarAppIcon } from "@/utils/avatar-app-icon";
import { Button } from "@vellumai/design-library/components/button";

export function AppIconCard() {
  const { t } = useTranslation("settings");
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { enabled, currentIcon, targetIcon, canOffer, apply, reset } =
    useAppIconSync(assistantId);
  const [pending, setPending] = useState(false);

  if (!enabled) {
    return null;
  }

  // Reset is offered for as long as one of our icons is applied, matching
  // avatar or not. A user who just pressed Match has an alternate icon and an
  // avatar that agrees with it, and this card is still their only way back to
  // the default. It sits beside Match whenever a different icon is on offer.
  const canReset = isAvatarAppIcon(currentIcon);

  const status =
    currentIcon === null
      ? t("appIconCard.statusDefault")
      : currentIcon === targetIcon
        ? t("appIconCard.statusMatched")
        : t("appIconCard.statusStale");

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  };

  return (
    <DetailCard title={t("appIconCard.title")}>
      <div className="flex flex-col gap-3">
        <div>
          <div className="text-body-medium-default text-[var(--content-default)]">
            {status}
          </div>
          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            {t("appIconCard.description")}
          </p>
        </div>
        {canOffer || canReset ? (
          <div className="flex flex-wrap gap-2">
            {canOffer ? (
              <Button
                variant="outlined"
                disabled={pending}
                onClick={() => void run(apply)}
              >
                {t("appIconCard.match")}
              </Button>
            ) : null}
            {canReset ? (
              <Button
                variant="outlined"
                disabled={pending}
                onClick={() => void run(reset)}
              >
                {t("appIconCard.reset")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </DetailCard>
  );
}
