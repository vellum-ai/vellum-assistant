/**
 * The frame the billing Plan stories mount inside. The tile and its panel fill
 * whatever column the settings row gives them, so the width is pinned here
 * rather than left to the centered layout's shrink-wrap. A story that needs a
 * wider or narrower column sets the `frameWidth` parameter.
 */
import type { Decorator } from "@storybook/react-vite";

/** The width the billing Plan row gives a single tile (roughly half a card). */
export const PLAN_TILE_WIDTH_PX = 420;

export const frameWidthDecorator: Decorator = (Story, context) => (
  <div
    style={{
      width:
        (context.parameters["frameWidth"] as number | undefined) ??
        PLAN_TILE_WIDTH_PX,
    }}
  >
    <Story />
  </div>
);
