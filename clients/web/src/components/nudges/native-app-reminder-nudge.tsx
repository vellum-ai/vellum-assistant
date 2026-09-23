import { NativeAppBanner } from "@/components/nudges/native-app-banner";
import {
  resolveMobilePromotion,
  useNativeAppNudgeState,
} from "@/hooks/use-native-app-nudge";
import {
  useIsAndroidWeb,
  useIsIOSSafariWeb,
  useIsIOSWeb,
  useIsNativeMobile,
} from "@/runtime/platform-detection";

interface NativeAppReminderNudgeProps {
  surface: "schedule-created" | "notifications-empty";
}

export function NativeAppReminderNudge({
  surface,
}: NativeAppReminderNudgeProps) {
  const isNativeMobile = useIsNativeMobile();
  const isIOSWeb = useIsIOSWeb();
  const isIOSSafariWeb = useIsIOSSafariWeb();
  const isAndroidWeb = useIsAndroidWeb();
  const ios = resolveMobilePromotion("ios");
  const android = resolveMobilePromotion("android");
  const iosNudge = useNativeAppNudgeState(ios.target, surface);
  const androidNudge = useNativeAppNudgeState(android.target, surface);

  if (
    isNativeMobile ||
    !iosNudge.bannerShouldShow ||
    !androidNudge.bannerShouldShow
  ) {
    return null;
  }

  const promotion = isAndroidWeb ? android : ios;
  const nudge = isAndroidWeb ? androidNudge : iosNudge;
  const offerBoth = !isIOSWeb && !isIOSSafariWeb && !isAndroidWeb;

  return (
    <div className="my-3">
      <NativeAppBanner
        promotion={promotion}
        onDownload={nudge.handleDownload}
        onDismiss={nudge.handleBannerDismiss}
        surface={surface}
        alternative={
          offerBoth
            ? { promotion: android, onDownload: androidNudge.handleDownload }
            : undefined
        }
      />
    </div>
  );
}
