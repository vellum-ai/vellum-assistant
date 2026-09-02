import { NativeAppCardView } from "@/domains/settings/components/native-app-card-view";
import {
  resolveMobilePromotion,
  type NativeAppPlatform,
} from "@/hooks/use-native-app-nudge";
import {
  useIsAndroidWeb,
  useIsIOSSafariWeb,
  useIsIOSWeb,
  useIsMobileWeb,
} from "@/runtime/platform-detection";

export function NativeAppCard() {
  const isIOSWeb = useIsIOSWeb();
  const isIOSSafariWeb = useIsIOSSafariWeb();
  const isAndroidWeb = useIsAndroidWeb();
  const isMobileWeb = useIsMobileWeb();

  // Desktop has its own nudge, so this card is mobile-only. Every mobile
  // browser gets one: the resolver falls back to the downloads page for the
  // platforms it cannot name a store listing for.
  if (!isIOSWeb && !isIOSSafariWeb && !isAndroidWeb && !isMobileWeb) {
    return null;
  }

  // Safari is excluded from the in-chat banner because Apple's Smart App
  // Banner covers it, but this card still names the store we know the reader
  // is on rather than falling through to the generic downloads page.
  const platform: NativeAppPlatform | null =
    isIOSWeb || isIOSSafariWeb ? "ios" : isAndroidWeb ? "android" : null;

  return <NativeAppCardView promotion={resolveMobilePromotion(platform)} />;
}
