import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { ComposerNotices } from "@/domains/chat/components/composer-notices";

afterEach(cleanup);

/**
 * Stands in for `DiskPressureBannerSlot`, which is always mounted so it can
 * keep its dismiss flags in step with the monitor, and renders nothing for as
 * long as the disk is healthy.
 */
function QuietSlot() {
  return null;
}

const REQUIRED = {
  showMissingApiKeyBanner: false,
  onOpenAiSettings: () => {},
  onDismissApiKeyError: () => {},
  showMaintenanceBanner: false,
};

describe("ComposerNotices", () => {
  test("a slot that renders nothing leaves no element behind", () => {
    // GIVEN a composer with no banner to show, whose disk-pressure slot is
    // mounted all the same
    const { container } = render(
      <ComposerNotices {...REQUIRED} diskPressureBanner={<QuietSlot />} />,
    );

    // THEN the stack is empty. `ChatComposer` counts the elements above its
    // card to decide whether a banner is standing there, and an empty spacer
    // left by a quiet slot would take the settings pills and the avatar peek
    // down with it for the whole session.
    expect(container.childElementCount).toBe(0);
  });

  test("a slot with a banner in it still renders", () => {
    // GIVEN the same composer, with the slot showing something
    const { container } = render(
      <ComposerNotices
        {...REQUIRED}
        diskPressureBanner={<div data-testid="disk-banner">Running low</div>}
      />,
    );

    // THEN it reaches the stack, and counts
    expect(container.querySelector('[data-testid="disk-banner"]')).not.toBe(
      null,
    );
    expect(container.childElementCount).toBeGreaterThan(0);
  });
});
