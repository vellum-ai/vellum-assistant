/**
 * One still to one luma grid, for a source that has no stream.
 *
 * The companion's screen share is handed a JPEG per occasion by the host's
 * helper, and the frame gate wants the same 16x16 grid a `<video>` frame is
 * reduced to. The bytes are decoded by `createImageBitmap` and drawn through
 * the producer the caller holds, so the grid is byte for byte what the
 * browser sampler would have made of the same picture, and one canvas pair
 * serves the whole share.
 */

import type { FrameGrid } from "./frame-gate";
import type { FrameGridProducer } from "./frame-sampler";

/**
 * Reduce a JPEG to the gate's grid, or null for a picture that could not be
 * decoded or a document with no 2D context to draw it through.
 *
 * The grid is the producer's one reused buffer, so it is only good until the
 * next call on the same producer: offer it to the gate before taking another.
 */
export async function stillFrameGrid(
  bytes: Uint8Array<ArrayBuffer>,
  grids: FrameGridProducer,
): Promise<FrameGrid | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  } catch {
    return null;
  }
  try {
    return grids.gridFrom(bitmap);
  } finally {
    bitmap.close();
  }
}
