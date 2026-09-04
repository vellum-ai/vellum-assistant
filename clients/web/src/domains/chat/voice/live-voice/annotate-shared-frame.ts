/**
 * Drawing the user's marks onto a frame of what they are sharing.
 *
 * **This exists because the overlay is never in the pixels.** The marks are
 * drawn in one of Vellum's own windows, and a capture excludes those
 * deliberately (`ScreenCapture.swift`, `ownWindows`), so a frame taken while
 * a circle is on screen comes back without it. The call would be shown the
 * screen and told "this one", with nothing saying which. So the frame that
 * goes is this one: the helper's JPEG with the same strokes drawn onto it,
 * from the same numbers the overlay drew.
 *
 * The strokes are fractions of the shared surface, which is what makes this
 * possible at all: the helper hands back a JPEG scaled to fit a bound, and a
 * fraction means the same thing at any size. Nothing here needs to know what
 * the surface was, how big it is, or where on the desktop it sits.
 *
 * The colour travels with them rather than being resolved again here. The
 * window that drew the marks resolved the assistant's accent from state it
 * has and this one does not, and a second resolution that came out differently
 * would put a drawing in the transcript in a colour the user never saw.
 */

import { captureError } from "@/lib/sentry/capture-error";
import {
  COMPANION_ANNOTATION_STROKE,
  type CompanionAnnotationStroke,
} from "@vellumai/ipc-contract";

/** Where a failure is filed, so the tag says which source it came from. */
const ERROR_CONTEXT = "live-voice screen share: draw annotation onto frame";

/**
 * How much of the ink is a dark halo under the line.
 *
 * A single-colour line disappears against a surface of its own colour, and
 * the surface here is whatever the user happens to be showing. The halo is
 * what keeps a mark readable over a bright document and a dark editor alike,
 * for the reason a subtitle is drawn with one.
 */
const HALO_SCALE = 2.2;
const HALO_COLOR = "rgba(0, 0, 0, 0.35)";

/**
 * `frame` with `strokes` drawn onto it, or `frame` itself when there is
 * nothing to draw or nothing to draw with.
 *
 * Never throws and never returns nothing: an annotated frame is better than a
 * plain one, and a plain one is far better than no frame at all. A browser
 * that cannot give a 2D context, an image that will not decode, an encoder
 * that returns null: each of them costs the marks and keeps the picture, and
 * the user is left having pointed at something on a screen the call can still
 * see.
 */
export async function annotateSharedFrame(
  frame: File,
  strokes: readonly CompanionAnnotationStroke[],
  ink: string,
): Promise<File> {
  if (strokes.length === 0) {
    return frame;
  }
  try {
    const image = await decode(frame);
    // Read before anything is released: closing a bitmap takes its dimensions
    // to zero, and the marks are placed against them.
    const { width, height } = image;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) {
      return frame;
    }
    context.drawImage(image, 0, 0);
    if ("close" in image) {
      image.close();
    }
    draw(context, strokes, width, height, ink);
    const blob = await encode(canvas);
    if (blob === null) {
      return frame;
    }
    return new File([blob], frame.name, { type: "image/jpeg" });
  } catch (error) {
    captureError(error, { context: ERROR_CONTEXT });
    return frame;
  }
}

/**
 * The marks, in the frame's own pixels.
 *
 * Exported for its tests, which drive a stub context: the arithmetic that
 * turns a fraction into a pixel is the whole of what can be wrong here, and a
 * canvas is not something a test in jsdom can look at.
 */
export function draw(
  context: Pick<
    CanvasRenderingContext2D,
    | "beginPath"
    | "moveTo"
    | "lineTo"
    | "arc"
    | "stroke"
    | "fill"
    | "lineCap"
    | "lineJoin"
    | "lineWidth"
    | "strokeStyle"
    | "fillStyle"
  >,
  strokes: readonly CompanionAnnotationStroke[],
  width: number,
  height: number,
  ink: string,
): void {
  // The same side the fraction means, so a mark drawn on a display and the
  // same mark on a tall window carry the same weight relative to what they
  // are on.
  const line = COMPANION_ANNOTATION_STROKE * Math.min(width, height);
  context.lineCap = "round";
  context.lineJoin = "round";
  // The halo first and the ink over it, both as complete passes: drawn stroke
  // by stroke, one mark's halo would sit on top of the one before it and cut
  // a dark line through it wherever two marks cross.
  for (const pass of [
    { color: HALO_COLOR, lineWidth: line * HALO_SCALE },
    { color: ink, lineWidth: line },
  ]) {
    context.strokeStyle = pass.color;
    context.fillStyle = pass.color;
    context.lineWidth = pass.lineWidth;
    for (const stroke of strokes) {
      const points = stroke.points;
      const first = points[0];
      if (first === undefined) {
        continue;
      }
      context.beginPath();
      // A press that never moved is a dot: a path of one point strokes
      // nothing at all, round caps included.
      if (points.length === 1) {
        context.arc(
          first.x * width,
          first.y * height,
          pass.lineWidth / 2,
          0,
          Math.PI * 2,
        );
        context.fill();
        continue;
      }
      context.moveTo(first.x * width, first.y * height);
      for (const point of points.slice(1)) {
        context.lineTo(point.x * width, point.y * height);
      }
      context.stroke();
    }
  }
}

/** The frame as something a canvas can draw, and released once it has been. */
async function decode(frame: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(frame);
  }
  // The fallback path, for a host without `createImageBitmap`. The object URL
  // is revoked either way: a leak here is one per drawing, on a gesture the
  // user can repeat as fast as they can draw.
  const url = URL.createObjectURL(frame);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        resolve(image);
      };
      image.onerror = () => {
        reject(new Error("could not decode the shared frame"));
      };
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The annotated frame back as JPEG, at the quality the upload path expects.
 *
 * JPEG rather than what the canvas would default to, because this replaces a
 * JPEG the helper already sized for the trip and the attachment path resizes
 * on the way up: a PNG of a screenshot is several times the bytes for a
 * picture nobody looks at more closely.
 */
function encode(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.85);
  });
}
