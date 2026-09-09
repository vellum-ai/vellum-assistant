import { describe, expect, test } from "bun:test";

import { FRAME_GRID_CELLS } from "./frame-gate";
import type { FrameGridProducer } from "./frame-sampler";
import { stillFrameGrid } from "./still-frame-grid";

describe("stillFrameGrid", () => {
  /**
   * happy-dom decodes no pictures at all, which stands in for a JPEG the
   * browser cannot decode: the answer is no grid, not a throw, so a bad frame
   * costs the share one occasion rather than the run.
   */
  test("answers null for a picture that cannot be decoded, and draws nothing", async () => {
    let drawn = 0;
    const grids: FrameGridProducer = {
      gridFrom: () => {
        drawn += 1;
        return new Uint8Array(FRAME_GRID_CELLS);
      },
    };
    const grid = await stillFrameGrid(
      new TextEncoder().encode("not a jpeg"),
      grids,
    );
    expect(grid).toBeNull();
    expect(drawn).toBe(0);
  });
});
