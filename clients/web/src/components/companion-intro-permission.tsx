import { Button } from "@vellumai/design-library/components/button";

import { useTranslation } from "@/i18n";
import {
  companionIntroOpensSettings,
  type CompanionIntroPermission as Permission,
} from "./use-companion-intro-permission";

const COPY = {
  microphone: {
    action: "companionIntro.permission.microphoneAction",
    body: "companionIntro.permission.microphoneBody",
  },
  inputMonitoring: {
    action: "companionIntro.permission.openSettings",
    body: "companionIntro.permission.shortcutBody",
  },
  screen: {
    action: "companionIntro.permission.screenAction",
    body: "companionIntro.permission.screenBody",
  },
} as const;

export function CompanionIntroPermission({
  permission,
}: {
  permission: Permission;
}) {
  const { t } = useTranslation();
  const { state } = permission;
  const item = state.phase === "known" ? state.item : null;
  const busy = state.phase === "checking" || state.phase === "requesting";
  const settings = companionIntroOpensSettings(permission.kind, item);
  const restricted = item?.status === "restricted";
  const error = state.phase === "error" || item?.error !== undefined;
  const copy = COPY[permission.kind];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <p className="text-[14px] leading-[1.45] text-white/70">{t(copy.body)}</p>
      <Button
        size="compact"
        shape="pill"
        className="self-start bg-white/15 text-white hover:bg-white/25"
        loading={busy}
        disabled={restricted || state.phase === "checking"}
        onClick={permission.enable}
      >
        {settings
          ? t("companionIntro.permission.openSettings")
          : t(copy.action)}
      </Button>
      <p role="status" className="text-[12px] leading-tight text-white/60">
        {restricted
          ? t("companionIntro.permission.restricted")
          : error
            ? t("companionIntro.permission.error")
            : settings
              ? t("companionIntro.permission.settingsHint")
              : busy
                ? t("companionIntro.permission.waiting")
                : null}
      </p>
    </div>
  );
}
