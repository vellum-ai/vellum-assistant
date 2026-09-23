import { describe, expect, test } from "bun:test";

import sharp from "sharp";

import { parseImageDimensions } from "../context/image-dimensions.js";
import { prepareComputerUseObservation } from "./computer-use-observation.js";
import { HostCuProxy } from "./host-cu-proxy.js";

async function screenshot(width: number, height: number): Promise<string> {
  const bytes = await sharp({
    create: { width, height, channels: 3, background: "white" },
  })
    .jpeg()
    .toBuffer();
  return bytes.toString("base64");
}

describe("computer-use observation transport", () => {
  test("derives metadata from emitted screenshot bytes", async () => {
    const image = await screenshot(835, 540);
    const observation = await prepareComputerUseObservation({
      screenshot: image,
      screenshotWidthPx: 1728,
      screenshotHeightPx: 1117,
      screenWidthPt: 1728,
      screenHeightPt: 1117,
    });

    expect(observation.screenshot).toBe(image);
    expect(observation.screenshotWidthPx).toBe(835);
    expect(observation.screenshotHeightPx).toBe(540);
  });

  test("formats the optimized dimensions on the virtual desktop path", async () => {
    const image = await screenshot(3200, 1800);
    const proxy = new HostCuProxy();
    const result = await proxy.executeLocal(
      "computer_use_observe",
      {},
      async () => ({
        screenshot: image,
        screenshotWidthPx: 3200,
        screenshotHeightPx: 1800,
        screenWidthPt: 1600,
        screenHeightPt: 900,
      }),
    );

    const block = result.contentBlocks?.[0];
    expect(block?.type).toBe("image");
    if (block?.type !== "image" || block.source.type !== "base64") {
      throw new Error("Expected screenshot bytes");
    }
    const dimensions = parseImageDimensions(block.source);
    expect(dimensions).toEqual({ width: 1568, height: 882 });
    const repeated = await prepareComputerUseObservation({
      screenshot: block.source.data,
    });
    expect(repeated.screenshot).toBe(block.source.data);
    expect(result.content).toContain("1568x882 px");
    expect(result.content).toContain("x = round(image_x * 1.020408)");
    expect(result.content).toContain("y = round(image_y * 1.020408)");
    proxy.dispose();
  });

  test("does not trust dimension metadata when image bytes cannot be read", async () => {
    const observation = await prepareComputerUseObservation({
      screenshot: "invalid",
      screenshotWidthPx: 800,
      screenshotHeightPx: 600,
    });

    expect(observation.screenshotWidthPx).toBeUndefined();
    expect(observation.screenshotHeightPx).toBeUndefined();
  });

  test("leaves observations without a screenshot alone", async () => {
    const observation = { axTree: "[1] AXButton Save" };
    expect(await prepareComputerUseObservation(observation)).toBe(observation);
  });
});
