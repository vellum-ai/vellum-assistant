/**
 * "App icon" row in the Preferences card on Settings -> General.
 *
 * The only entry point the feature has: it shows what is on the home screen
 * right now and opens {@link AppIconModal} to change it. Every swap starts
 * here, on a press, and this is also the only way back to the default icon, so
 * an avatar switched to an uploaded image leaves the old icon in place until
 * someone resets it from the picker.
 *
 * Draws nothing at all outside the native mobile shells, on Android with
 * `android-avatar-app-icon` off, or on a build that ships no alternate icons.
 */
import { useState } from "react";

import { AppIconPreview } from "@/components/avatar/app-icon-preview";
import { APP_ICON_GROUNDS } from "@/components/ios-widget-previews/vellum-app-icon-mark";
import { AppIconModal } from "@/domains/settings/components/app-icon-modal";
import { useAppIconSync, type AppIconSync } from "@/hooks/use-app-icon-sync";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
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

/** A shell's icon ground, in both gamuts a renderer might take it in. */
interface IconGround {
  /** The fill the shell's Icon Composer bundle declares. */
  displayP3: string;
  /**
   * The same color in sRGB: what the Android flavor's `launcher_background`
   * declares, and what a renderer that cannot parse `color()` falls back to.
   */
  srgb: string;
}

/**
 * Vellum Dev draws its icon on pink on both platforms.
 *
 * `clients/ios/App/App/AppIcon-Dev.icon` declares its fill as the Display P3
 * conversion of the sRGB hex {@link APP_ICON_GROUNDS} carries, and
 * `clients/android/app/src/dev/res/values/colors.xml` declares that hex itself.
 * Naming the same coordinates draws the thumbnail in the gamut the installed
 * icon is drawn in.
 */
const DEV_GROUND: IconGround = {
  displayP3: "color(display-p3 0.9387 0.55755 0.7777)",
  srgb: APP_ICON_GROUNDS.dev,
};

/** Vellum Staging's yellow, read the same way off the same pair of shells. */
const STAGING_GROUND: IconGround = {
  displayP3: "color(display-p3 0.89313 0.79283 0.2841)",
  srgb: APP_ICON_GROUNDS.staging,
};

/**
 * Ground the primary icon is drawn on in the shells that do not ship the
 * production one, keyed by the shell's own environment.
 *
 * A thumbnail standing in for "no alternate applied" follows the shell it is
 * running in or it depicts an icon that is on nobody's home screen. It is the
 * shell that is asked and not `VITE_SENTRY_ENVIRONMENT`, because the icon
 * belongs to the installed build while that variable names the web deploy: a
 * Staging shell loading a dev server would otherwise draw pink under a yellow
 * icon. Production is absent: the catalog green
 * {@link DEFAULT_APP_ICON_TRAITS} names is already that shell's ground on both
 * platforms, and its iOS bundle carries a true conversion of it.
 */
const PRIMARY_ICON_GROUND: Partial<Record<ShellEnvironment, IconGround>> = {
  dev: DEV_GROUND,
  staging: STAGING_GROUND,
};

/**
 * Environment to fall back to when the shell names none, keyed by
 * `VITE_SENTRY_ENVIRONMENT`. An unset value is a local build, which each
 * project runs on its own dev build (the App Dev scheme in
 * `clients/ios/README.md`, the `dev` flavor on Android), so it reads as dev.
 */
const WEB_ENV_SHELL_ENVIRONMENT: Record<string, ShellEnvironment> = {
  local: "dev",
  dev: "dev",
  staging: "staging",
};

/** Whether the renderer parses a CSS Color 4 `color()` at all. */
function supportsDisplayP3(): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    return false;
  }
  return CSS.supports("color", "color(display-p3 1 1 1)");
}

/** A ground in the widest gamut the renderer can take it in. */
function groundFill(ground: IconGround | undefined): string | undefined {
  if (!ground) {
    return undefined;
  }
  return supportsDisplayP3() ? ground.displayP3 : ground.srgb;
}

/**
 * Environment whose primary icon the thumbnail stands in for: the shell's own
 * wherever it named one, the web deploy's where it named none, and none at all
 * while it has yet to answer.
 */
function primaryIconEnvironment(
  shell: ShellEnvironment | null | undefined,
): ShellEnvironment | undefined {
  if (shell) {
    return shell;
  }
  if (shell === null) {
    return WEB_ENV_SHELL_ENVIRONMENT[
      import.meta.env.VITE_SENTRY_ENVIRONMENT ?? "local"
    ];
  }
  return undefined;
}

/**
 * Ground the running shell's primary icon carries, undefined on production and
 * while the shell has yet to answer, which draws the production green for the
 * frame or two that takes. Both platforms ground the same environment in the
 * same color and only the gamut parts them: an Android `launcher_background` is
 * plain sRGB and the flavors ship no wide-gamut variant of it.
 */
function primaryIconGround(
  shell: ShellEnvironment | null | undefined,
  android: boolean,
): string | undefined {
  const environment = primaryIconEnvironment(shell);
  if (!environment) {
    return undefined;
  }
  const ground = PRIMARY_ICON_GROUND[environment];
  return android ? ground?.srgb : groundFill(ground);
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
  const isAndroidShell = useIsNativeAndroid();
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
          <p className="text-body-small-lighter text-[var(--content-tertiary)]">
            {t("appIcon.description")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <AppIconPreview
            components={catalog}
            eyeStyle={traits.eyeStyle}
            color={traits.color}
            primary={isPrimary}
            fieldColor={
              isPrimary
                ? primaryIconGround(shellEnvironment, isAndroidShell)
                : undefined
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
