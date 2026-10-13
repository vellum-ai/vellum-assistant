import { NativeAppBanner } from "@/components/nudges/native-app-banner";
import {
  resolveMobilePromotion,
  useNativeAppNudgeState,
} from "@/hooks/use-native-app-nudge";
import {
  useIsAndroidWeb,
  useIsIOSSafariWeb,
  useIsIOSWeb,
  useIsMobileWeb,
  useIsNativeMobile,
} from "@/runtime/platform-detection";
import { emitNativeAppNudgeEvent } from "@/utils/native-app-nudge-telemetry";

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
  const isMobileWeb = useIsMobileWeb();
  const offerBoth =
    !isIOSWeb && !isIOSSafariWeb && !isAndroidWeb && !isMobileWeb;
  const promotion = resolveMobilePromotion(
    isIOSWeb || isIOSSafariWeb || offerBoth
      ? "ios"
      : isAndroidWeb
        ? "android"
        : null,
  );
  const android = resolveMobilePromotion("android");
  const nudge = useNativeAppNudgeState(promotion.target, surface);
  const androidNudge = useNativeAppNudgeState(android.target, surface);

  if (
    isNativeMobile ||
    !nudge.bannerShouldShow ||
    !androidNudge.bannerShouldShow
  ) {
    return null;
  }

  return (
    <div className="my-3">
      <NativeAppBanner
        promotion={promotion}
        onDownload={nudge.handleDownload}
        onDismiss={() => {
          nudge.handleBannerDismiss();
          if (offerBoth) {
            emitNativeAppNudgeEvent("dismiss", surface, android.target);
          }
        }}
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
