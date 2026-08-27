/**
 * The in-chat banner that offers the native app to a mobile web reader.
 *
 * `resolveMobilePromotion` picks one of three targets, and the banner reads
 * the copy off the one it is handed. iOS and Android name their platform and
 * link their store listing. Generic names neither, and covers the two cases
 * where naming one would be wrong: a mobile browser the OS checks could not
 * identify, and Android on a deployment with no Play Store listing
 * configured. It sends those readers to the Vellum downloads page instead.
 *
 * The subtitle and the CTA label are shared by all three.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { NativeAppBanner } from "@/components/nudges/native-app-banner";
import {
  getNativeAppName,
  resolveMobilePromotion,
  type NativeAppPromotion,
} from "@/hooks/use-native-app-nudge";

/**
 * `resolveMobilePromotion("android")` answers with the generic promotion
 * unless `VITE_ANDROID_PLAY_STORE_URL` is configured, which Storybook does not
 * set, so the configured Android case is spelled out to keep it storyable.
 */
const ANDROID_PROMOTION: NativeAppPromotion = {
  target: "android",
  appName: getNativeAppName("android"),
  storeUrl: "https://play.google.com/store/apps/details?id=ai.vellum.assistant",
};

const meta: Meta<typeof NativeAppBanner> = {
  title: "Nudges/NativeAppBanner",
  component: NativeAppBanner,
  parameters: { layout: "padded" },
  args: {
    promotion: resolveMobilePromotion("ios"),
    onDownload: () => {},
    onDismiss: () => {},
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-[720px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof NativeAppBanner>;

/** iOS web, off Safari: the App Store listing, with the platform named. */
export const IOS: Story = {
  name: "iOS · App Store",
};

/**
 * Android web on a deployment that configured its Play Store listing. Without
 * that configuration this reader gets the Generic story below instead.
 */
export const Android: Story = {
  name: "Android · Play Store",
  args: { promotion: ANDROID_PROMOTION },
};

/**
 * The fallback: a mobile browser we could not identify, or Android with no
 * store listing configured. No platform is named anywhere, including in the
 * banner's `aria-label` and the CTA's, and the CTA opens the downloads page.
 */
export const Generic: Story = {
  name: "Generic · downloads page",
  args: { promotion: resolveMobilePromotion(null) },
};

/**
 * Phone width, which is the only width this banner actually ships at. Below
 * `md` the row tightens its gap, the subtitle steps up a size, and the
 * dismiss button regains its left margin, so the desktop stories above show a
 * treatment no reader of this banner sees.
 */
export const Mobile: Story = {
  name: "Mobile treatment",
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
