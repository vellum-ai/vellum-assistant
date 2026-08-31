/**
 * "App icon" row in the Preferences card on Settings -> General.
 *
 * The only entry point the feature has: it shows what is on the home screen
 * right now and opens {@link AppIconModal} to change it. Every swap starts
 * here, on a press, and this is also the only way back to the default icon, so
 * an avatar switched to an uploaded image leaves the old icon in place until
 * someone resets it from the picker.
 *
 * Draws nothing at all off native iOS, with the `ios-avatar-app-icon` flag
 * off, or on a build that ships no alternate icons.
 */
import { useState } from "react";

import { AppIconPreview } from "@/components/avatar/app-icon-preview";
import { AppIconModal } from "@/domains/settings/components/app-icon-modal";
import { useAppIconSync, type AppIconSync } from "@/hooks/use-app-icon-sync";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  DEFAULT_APP_ICON_TRAITS,
  traitsForAppIconName,
} from "@/utils/avatar-app-icon";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import { Button } from "@vellumai/design-library/components/button";

/** Size of the row's thumbnail, sitting beside a single-line control. */
const ROW_PREVIEW_SIZE = 32;

export function AppIconRow() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const sync = useAppIconSync(assistantId);

  // The catalog and the picker below belong to a row that actually draws, so
  // they hang off the gate instead of loading for every install this feature
  // is switched off on.
  if (!sync.enabled) {
    return null;
  }

  return <AppIconRowContent assistantId={assistantId} sync={sync} />;
}

interface AppIconRowContentProps {
  assistantId: string | null;
  sync: AppIconSync;
}

function AppIconRowContent({ assistantId, sync }: AppIconRowContentProps) {
  const { t } = useTranslation("settings");
  const { components } = useAssistantAvatar(assistantId);
  const bundledComponents = useBundledAvatarComponents();
  const [open, setOpen] = useState(false);

  // The daemon's catalog is what the avatar itself is drawn from, so the
  // previews agree with it. The static copy stands in when an assistant
  // wearing an uploaded image resolved without one, which is what keeps the
  // picker usable for exactly the users who cannot sync from an avatar.
  const catalog = components ?? bundledComponents;
  // With no alternate applied the thumbnail stands in for the app's primary
  // icon, which frames its pair on the default span whatever style it draws.
  const appliedTraits = traitsForAppIconName(sync.currentIcon);
  const traits = appliedTraits ?? DEFAULT_APP_ICON_TRAITS;

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="text-body-medium-lighter text-[var(--content-default)]">
            {t("appIcon.title")}
          </div>
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            {t("appIcon.description")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <AppIconPreview
            components={catalog}
            eyeStyle={traits.eyeStyle}
            color={traits.color}
            primary={appliedTraits === null}
            size={ROW_PREVIEW_SIZE}
          />
          <Button variant="outlined" onClick={() => setOpen(true)}>
            {t("appIcon.change")}
          </Button>
        </div>
      </div>
      <AppIconModal
        open={open}
        onClose={() => setOpen(false)}
        components={catalog}
        currentIcon={sync.currentIcon}
        targetIcon={sync.targetIcon}
        canSyncAvatar={sync.canSyncAvatar}
        availableIcons={sync.availableIcons}
        onApply={sync.apply}
        onReset={sync.reset}
      />
    </>
  );
}
