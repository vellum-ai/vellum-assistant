import { afterEach, describe, expect, mock, test } from "bun:test";

let openedUrl: string | null = null;
mock.module("@/runtime/browser", () => ({
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
}));

const { billingSiteUrl, openBillingPathInBrowser } = await import(
  "@/lib/billing/android-billing-handoff"
);

afterEach(() => {
  openedUrl = null;
});

describe("billingSiteUrl", () => {
  test("resolves an app path, query included, against the page origin", () => {
    const url = billingSiteUrl("/assistant/settings/usage?tab=billing");
    expect(url).toBe(
      `${window.location.origin}/assistant/settings/usage?tab=billing`,
    );
  });
});

describe("openBillingPathInBrowser", () => {
  test("hands the absolute URL to the shared browser opener", () => {
    openBillingPathInBrowser("/assistant/plans");
    expect(openedUrl).toBe(`${window.location.origin}/assistant/plans`);
  });
});
