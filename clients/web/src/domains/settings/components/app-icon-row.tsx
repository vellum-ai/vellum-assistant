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
import { APP_ICON_GROUNDS } from "@/components/ios-widget-previews/vellum-app-icon-mark";
import { AppIconModal } from "@/domains/settings/components/app-icon-modal";
import { useAppIconSync, type AppIconSync } from "@/hooks/use-app-icon-sync";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";
import {
  useShellEnvironment,
  type ShellEnvironment,
} from "@/runtime/shell-environment";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  DEFAULT_APP_ICON_TRAITS,
  traitsForAppIconName,
} from "@/utils/avatar-app-icon";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import { Button } from "@vellumai/design-library/components/button";

/** Size of the row's thumbnail, sitting beside a single-line control. */
const ROW_PREVIEW_SIZE = 32;

/**
 * Ground the primary icon is drawn on in the shells that do not ship the
 * production one, keyed by the shell's own environment.
 *
 * Vellum Dev draws its icon on pink and Vellum Staging on yellow
 * (`clients/ios/App/App/AppIcon-Dev.icon` and `AppIcon-Staging.icon`), so a
 * thumbnail standing in for "no alternate applied" follows the shell it is
 * running in or it depicts an icon that is on nobody's home screen. The
 * grounds themselves are the ones {@link APP_ICON_GROUNDS} already carries for
 * the widget previews, which is where the Icon Composer fills are converted.
 *
 * It is the shell that is asked and not `VITE_SENTRY_ENVIRONMENT`, because the
 * icon belongs to the installed build while that variable names the web
 * deploy: a Staging shell loading a dev server would otherwise draw pink under
 * a yellow icon. Production is absent: the catalog green
 * {@link DEFAULT_APP_ICON_TRAITS} names is already that shell's ground.
 */
const PRIMARY_ICON_GROUND: Partial<Record<ShellEnvironment, string>> = {
  dev: APP_ICON_GROUNDS.dev,
  staging: APP_ICON_GROUNDS.staging,
};

/**
 * Ground to draw when the shell names no environment we know, keyed by
 * `VITE_SENTRY_ENVIRONMENT`. An unset value is a local build, which
 * `clients/ios/README.md` runs on the App Dev scheme, so it takes the same
 * pink.
 */
const WEB_ENV_PRIMARY_ICON_GROUND: Record<string, string> = {
  local: APP_ICON_GROUNDS.dev,
  dev: APP_ICON_GROUNDS.dev,
  staging: APP_ICON_GROUNDS.staging,
};

/**
 * Ground the running shell's primary icon carries, undefined on production and
 * while the shell has yet to answer, which draws the production green for the
 * frame or two that takes.
 */
function primaryIconGround(
  shell: ShellEnvironment | null | undefined,
): string | undefined {
  if (shell) {
    return PRIMARY_ICON_GROUND[shell];
  }
  if (shell === null) {
    return WEB_ENV_PRIMARY_ICON_GROUND[
      import.meta.env.VITE_SENTRY_ENVIRONMENT ?? "local"
    ];
  }
  return undefined;
}

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
  const shellEnvironment = useShellEnvironment();
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
  const isPrimary = appliedTraits === null;

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
            primary={isPrimary}
            fieldColorHex={
              isPrimary ? primaryIconGround(shellEnvironment) : undefined
            }
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
