import { optimizeImageForTransport } from "../agent/image-optimize.js";
import { parseImageDimensions } from "../context/image-dimensions.js";
import type { CuObservationResult } from "./host-cu-proxy.js";

/** Keep coordinate metadata aligned with the image sent to the model. */
export async function prepareComputerUseObservation(
  observation: CuObservationResult,
): Promise<CuObservationResult> {
  if (!observation.screenshot) {
    return observation;
  }
  const image = await optimizeImageForTransport(
    observation.screenshot,
    "image/jpeg",
  );
  const dimensions = parseImageDimensions(image.data, image.mediaType);
  return {
    ...observation,
    screenshot: image.data,
    screenshotWidthPx: dimensions?.width,
    screenshotHeightPx: dimensions?.height,
  };
}
