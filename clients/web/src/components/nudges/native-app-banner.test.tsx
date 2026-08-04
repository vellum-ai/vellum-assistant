import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { NativeAppBanner } from "@/components/nudges/native-app-banner";

afterEach(cleanup);

describe("NativeAppBanner", () => {
  test("preserves the iOS promotion copy", () => {
    render(
      <NativeAppBanner
        platform="ios"
        onDownload={mock(() => {})}
        onDismiss={mock(() => {})}
      />,
    );

    expect(screen.getByText("Get the iOS app")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Download iOS app" }),
    ).toBeDefined();
  });

  test("renders Android-specific promotion copy", () => {
    render(
      <NativeAppBanner
        platform="android"
        onDownload={mock(() => {})}
        onDismiss={mock(() => {})}
      />,
    );

    expect(screen.getByText("Get the Android app")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Download Android app" }),
    ).toBeDefined();
  });
});
