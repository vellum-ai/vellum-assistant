/**
 * The mobile-app card in Settings → General. It renders for every mobile web
 * visitor, and the promotion it is handed decides the copy and the store link.
 *
 * - **iOS**: the App Store listing.
 * - **Android**: the Play listing, only once `VITE_ANDROID_PLAY_STORE_URL`
 *   names it.
 * - **Generic**: everything else, which is an Android build with no
 *   configured Play listing plus every mobile browser the iOS and Android
 *   checks did not claim. It drops the platform name from the copy and points
 *   at the downloads page.
 *
 * Desktop sees none of these: `NativeAppCard` renders `null` there, and macOS
 * gets its own nudge.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { NativeAppCardView } from "@/domains/settings/components/native-app-card-view";
import {
  getNativeAppName,
  resolveMobilePromotion,
  type NativeAppPromotion,
} from "@/hooks/use-native-app-nudge";

/**
 * `resolveMobilePromotion("android")` only names the Play listing when
 * `VITE_ANDROID_PLAY_STORE_URL` is configured, which Storybook does not set,
 * so the configured shape is spelled out here.
 */
const ANDROID_PROMOTION: NativeAppPromotion = {
  target: "android",
  appName: getNativeAppName("android"),
  storeUrl: "https://play.google.com/store/apps/details?id=ai.vellum.assistant",
};

const meta: Meta<typeof NativeAppCardView> = {
  title: "Settings/NativeAppCard",
  component: NativeAppCardView,
  args: {
    promotion: resolveMobilePromotion("ios"),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-[560px] p-6">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof NativeAppCardView>;

/** An iOS browser outside Safari, where the Smart App Banner is absent. */
export const IOS: Story = {
  name: "iOS",
};

/** An Android browser, with the Play listing configured for this build. */
export const Android: Story = {
  args: { promotion: ANDROID_PROMOTION },
};

/**
 * The fallback: no platform name in the copy, and the CTA opens the downloads
 * page rather than a store listing.
 */
export const Generic: Story = {
  args: { promotion: resolveMobilePromotion(null) },
};
