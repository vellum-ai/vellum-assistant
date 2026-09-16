/**
 * The frame the billing Plan stories mount inside, and the fixtures they
 * share. The tile and its panel fill whatever column the settings row gives
 * them, so the width is pinned here rather than left to the centered layout's
 * shrink-wrap. A story that needs a wider or narrower column sets the
 * `frameWidth` parameter.
 */
import type { Decorator } from "@storybook/react-vite";

import type { UsagePeriodEnd } from "@/domains/settings/billing/usage-balance-panel";

/** The width the billing Plan row gives a single tile (roughly half a card). */
export const PLAN_TILE_WIDTH_PX = 420;

/**
 * A bundled subscriber's cycle end, built from local noon the way the suites
 * build theirs, so the printed day holds whatever the host offset is. Spread
 * it with `kind: "renews"` for a sub that holds no bundle.
 */
export const STORY_PERIOD_END: UsagePeriodEnd = {
  at: new Date(2026, 8, 20, 12).toISOString(),
  kind: "resets",
};

export const frameWidthDecorator: Decorator = (Story, context) => (
  <div style={{ width: context.parameters.frameWidth ?? PLAN_TILE_WIDTH_PX }}>
    <Story />
  </div>
);
