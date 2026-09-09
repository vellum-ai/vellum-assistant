/**
 * One still to one luma grid, for a source that has no stream.
 *
 * The companion's screen share is handed a JPEG per occasion by the host's
 * helper, and the frame gate wants the same 16x16 grid a `<video>` frame is
 * reduced to. The bytes are decoded by `createImageBitmap` and drawn through
 * the producer the caller holds, so the grid is byte for byte what the
 * browser sampler would have made of the same picture, and one canvas pair
 * serves the whole share. The still's mean colour comes with it, since a
 * screen keeps the flat views a camera refuses and has only colour left to
 * tell two of them apart.
 */

import type { FrameGrid } from "./frame-gate";
import type { FrameGridProducer, Tint } from "./frame-sampler";

/** A still as the gate reads it, and as a flat-view comparison does. */
export interface StillFrame {
  /**
   * The producer's one reused buffer, so it is only good until the next
   * call on the same producer: offer it, or copy it, before taking another.
   */
  readonly grid: FrameGrid;
  readonly tint: Tint;
}

/**
 * Reduce a JPEG to the gate's grid and its mean colour, or null for a
 * picture that could not be decoded or a document with no 2D context to
 * draw it through.
 */
export async function stillFrameGrid(
  bytes: Uint8Array<ArrayBuffer>,
  grids: FrameGridProducer,
): Promise<StillFrame | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  } catch {
    return null;
  }
  try {
    const grid = grids.gridFrom(bitmap);
    const tint = grids.tintOfLastGrid();
    return grid === null || tint === null ? null : { grid, tint };
  } finally {
    bitmap.close();
  }
}
