import { BellRing } from "lucide-react";
import { Navigate } from "react-router";

import { AndroidNotificationSettingsCard } from "@/domains/settings/components/android-notification-settings-card";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { routes } from "@/utils/routes";

export function NotificationsPage() {
  const isNativeAndroid = useIsNativeAndroid();

  if (!isNativeAndroid) {
    return <Navigate replace to={routes.settings.general} />;
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-lift)] text-[var(--content-secondary)]">
          <BellRing className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="text-title-medium text-[var(--content-emphasised)]">
            Notifications
          </h1>
          <p className="mt-1 text-body-medium-lighter text-[var(--content-secondary)]">
            Manage how Vellum notifies you on this Android device.
          </p>
        </div>
      </div>

      <AndroidNotificationSettingsCard />
    </div>
  );
}
