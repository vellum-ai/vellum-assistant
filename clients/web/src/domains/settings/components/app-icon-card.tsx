/**
 * Settings entry point for the iOS home-screen icon.
 *
 * Every swap starts here, on a press: matching the icon to the assistant's
 * avatar, and the only way back to the default. Nothing in this feature resets
 * an icon on its own, so an avatar switched to an uploaded image leaves the old
 * icon in place until someone presses Reset here.
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
  const { enabled, currentIcon, targetIcon, canSyncAvatar, apply, reset } =
    useAppIconSync(assistantId);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!enabled) {
    return null;
  }

  // Reset is offered for as long as one of our icons is applied, matching
  // avatar or not. A user who just pressed Match has an alternate icon and an
  // avatar that agrees with it, and this card is still their only way back to
  // the default. It sits beside Match whenever a different icon is on offer.
  const canReset = isAvatarAppIcon(currentIcon);
  const matchIcon = canSyncAvatar ? targetIcon : null;

  const status =
    currentIcon === null
      ? t("appIconCard.statusDefault")
      : currentIcon === targetIcon
        ? t("appIconCard.statusMatched")
        : t("appIconCard.statusStale");

  // iOS can refuse a swap. The buttons come back either way, since a refused
  // swap leaves exactly the icon the user was trying to change still applied.
  const run = async (action: () => Promise<boolean>) => {
    setPending(true);
    try {
      setFailed(!(await action()));
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
          {failed ? (
            <p
              role="alert"
              className="mt-1 text-body-small-default text-[color:var(--content-negative)]"
            >
              {t("appIconCard.error")}
            </p>
          ) : null}
        </div>
        {matchIcon !== null || canReset ? (
          <div className="flex flex-wrap gap-2">
            {matchIcon !== null ? (
              <Button
                variant="outlined"
                disabled={pending}
                onClick={() => void run(() => apply(matchIcon))}
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
