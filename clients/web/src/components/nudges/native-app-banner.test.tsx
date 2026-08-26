import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { NativeAppBanner } from "@/components/nudges/native-app-banner";
import {
  getNativeAppName,
  IOS_APP_STORE_URL,
  resolveMobilePromotion,
  type NativeAppPromotion,
} from "@/hooks/use-native-app-nudge";

afterEach(cleanup);

const ANDROID_PROMOTION: NativeAppPromotion = {
  target: "android",
  appName: getNativeAppName("android"),
  storeUrl: "https://play.google.com/store/apps/details?id=ai.vellum.assistant",
};

function renderBanner(promotion: NativeAppPromotion) {
  render(
    <NativeAppBanner
      promotion={promotion}
      onDownload={mock(() => {})}
      onDismiss={mock(() => {})}
    />,
  );
}

describe("NativeAppBanner", () => {
  test("preserves the iOS promotion copy", () => {
    const promotion = resolveMobilePromotion("ios");
    expect(promotion.storeUrl).toBe(IOS_APP_STORE_URL);

    renderBanner(promotion);

    expect(screen.getByText("Get the iOS app")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Download iOS app" }),
    ).toBeDefined();
    expect(
      screen.getByRole("status", { name: "Download the iOS app" }),
    ).toBeDefined();
  });

  test("renders Android-specific promotion copy", () => {
    renderBanner(ANDROID_PROMOTION);

    expect(screen.getByText("Get the Android app")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Download Android app" }),
    ).toBeDefined();
    expect(
      screen.getByRole("status", { name: "Download the Android app" }),
    ).toBeDefined();
  });

  test("names no platform for the generic promotion", () => {
    const promotion = resolveMobilePromotion(null);
    expect(promotion.appName).toBeNull();

    renderBanner(promotion);

    expect(screen.getByText("Get the Vellum app")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Download Vellum mobile app" }),
    ).toBeDefined();
    expect(
      screen.getByRole("status", { name: "Download the Vellum mobile app" }),
    ).toBeDefined();
  });

  test("shares one subtitle and CTA label across all three targets", () => {
    for (const promotion of [
      resolveMobilePromotion("ios"),
      ANDROID_PROMOTION,
      resolveMobilePromotion(null),
    ]) {
      renderBanner(promotion);
      expect(
        screen.getByText("Push notifications · biometric login · haptics"),
      ).toBeDefined();
      expect(screen.getByText("Download")).toBeDefined();
      cleanup();
    }
  });
});
