/**
 * Shared `DisplayAttachment` fixtures for the attachment renderers' tests and
 * stories. Kept free of any test-runner import so `.stories.tsx` files can use
 * it; the `bun:test` stubs live in `attachment-test-helpers.tsx`.
 */

import type { DisplayAttachment } from "@/domains/chat/types/types";

/**
 * Tiny generated 96x96 PNGs, one per hue, used wherever a story needs a real
 * decodable thumbnail rather than an icon fallback.
 */
export const SAMPLE_PREVIEWS: string[] = [
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAA70lEQVR42u3YsQ2DQBREwdcZJRA6oAW3QO80gDa25JEu3Ogl9zUd5/X6Pt/79f3bPnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnV4EA/iQTyIB/EgHsSD1OFBPIgH8SAexIN4EA9ShwfxIB7Eg3gQD+JBPMgfx4N4EA/iQTyIB/EgHsSD1OFBPIgH8SAexIN4EA9ShwfxIB7Eg3gQD+JBPMgFwIN4EA/iQTyIB/EgHsSD1OFBPIgH8SAexIN4EA9ShwfxIB7Eg3gQD+JBPMgFwIN4EA/iQTzop/cPo8PkO85qWSYAAAAASUVORK5CYII=",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAA70lEQVR42u3YsQ2DQBREwdcZBVCAE3KXQes0gDa25JEu3Ogl9zVd5/H67u/n9f3bPnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnX2PnV4EA/iQTyIB/EgHsSD1OFBPIgH8SAexIN4EA9ShwfxIB7Eg3gQD+JBPMgfx4N4EA/iQTyIB/EgHsSD1OFBPIgH8SAexIN4EA9ShwfxIB7Eg3gQD+JBPMgFwIN4EA/iQTyIB/EgHsSD1OFBPIgH8SAexIN4EA9ShwfxIB7Eg3gQD+JBPMgFwIN4EA/iQTzop/cPi1d4O2QKRFUAAAAASUVORK5CYII=",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAA70lEQVR42u3YoQ3DQBREwdebiTsIMUsTLt8NWIsjZaSDix65r+n4nK/vur+v79/2qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qcODeBAP4kE8iAfxIB6kDg/iQTyIB/EgHsSDeJA6PIgH8SAexIN4EA/iQf44HsSDeBAP4kE8iAfxIB6kDg/iQTyIB/EgHsSDeJA6PIgH8SAexIN4EA/iQS4AHsSDeBAP4kE8iAfxIB6kDg/iQTyIB/EgHsSDeJA6PIgH8SAexIN4EA/iQS4AHsSDeBAP4kE/vX8A3VnELJtLlW4AAAAASUVORK5CYII=",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAA7klEQVR42u3YsQ3DMBAEwS3OuTpQBW7CnasB4mIBHoDhRZvwMV2f+/i+9+/4/m2fOnufOnufOnufOnufOnufOnufOnufOnufOnufOnufOnufOnufOnufOnufOnufOjyIB/EgHsSDeBAP4kHq8CAexIN4EA/iQTyIB6nDg3gQD+JBPIgH8SAe5I/jQTyIB/EgHsSDeBAP4kHq8CAexIN4EA/iQTyIB6nDg3gQD+JBPIgH8SAe5ALgQTyIB/EgHsSDeBAP4kHq8CAexIN4EA/iQTyIB6nDg3gQD+JBPIgH8SAe5ALgQTyIB/EgHvTq/QMeCDpZKCPwnAAAAABJRU5ErkJggg==",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAA70lEQVR42u3YsQnDQBREwVeWmhAG1eFE/SdqQGxs8MCFG73kPtP1OV7f/T1f37/tU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU4cH8SAexIN4EA/iQTxIHR7Eg3gQD+JBPIgH8SB1eBAP4kE8iAfxIB7Eg/xxPIgH8SAexIN4EA/iQTxIHR7Eg3gQD+JBPIgH8SB1eBAP4kE8iAfxIB7Eg1wAPIgH8SAexIN4EA/iQTxIHR7Eg3gQD+JBPIgH8SB1eBAP4kE8iAfxIB7Eg1wAPIgH8SAexIN+ev8A6As4HS9kpJoAAAAASUVORK5CYII=",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAA7UlEQVR42u3YsQ3DMBAEwS3MVShTGU5VvRogLjbgARhetAkf0+e6j+/6Psf3b/vU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU2fvU4UE8iAfxIB7Eg3gQD1KHB/EgHsSDeBAP4kE8SB0exIN4EA/iQTyIB/EgfxwP4kE8iAfxIB7Eg3gQD1KHB/EgHsSDeBAP4kE8SB0exIN4EA/iQTyIB/EgFwAP4kE8iAfxIB7Eg3gQD1KHB/EgHsSDeBAP4kE8SB0exIN4EA/iQTyIB/EgFwAP4kE8iAfxoJ/ev2/xijtU5xswAAAAAElFTkSuQmCC",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAA70lEQVR42u3YoQ3DQBREwVeemTsIMU0T7twNWIsjZaSDix65r+lznK/vvr6v79/2qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qcODeBAP4kE8iAfxIB6kDg/iQTyIB/EgHsSDeJA6PIgH8SAexIN4EA/iQf44HsSDeBAP4kE8iAfxIB6kDg/iQTyIB/EgHsSDeJA6PIgH8SAexIN4EA/iQS4AHsSDeBAP4kE8iAfxIB6kDg/iQTyIB/EgHsSDeJA6PIgH8SAexIN4EA/iQS4AHsSDeBAP4kE/vX8AkMfcWd+1vLwAAAAASUVORK5CYII=",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAA70lEQVR42u3YoQ3DQBREwdeamXGYcSpw/8QNWIsjZaSDix65r+n8HK/ve1+v79/2qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qbP3qcODeBAP4kE8iAfxIB6kDg/iQTyIB/EgHsSDeJA6PIgH8SAexIN4EA/iQf44HsSDeBAP4kE8iAfxIB6kDg/iQTyIB/EgHsSDeJA6PIgH8SAexIN4EA/iQS4AHsSDeBAP4kE8iAfxIB6kDg/iQTyIB/EgHsSDeJA6PIgH8SAexIN4EA/iQS4AHsSDeBAP4kE/vX8Au7CSHXnIoW4AAAAASUVORK5CYII=",
];

/**
 * A non-square preview: three bands along the long edge. Dropped into a square
 * tile, `object-cover` eats most of the outer two, which is the crop a tile
 * story is there to show.
 */
export function makeSamplePreview(width: number, height: number): string {
  const landscape = width > height;
  const band = (landscape ? width : height) / 3;
  const bands = [0, 1, 2]
    .map((index) => {
      const fill = `hsl(196 58% ${34 + index * 16}%)`;
      const offset = index * band;
      return landscape
        ? `<rect x="${offset}" y="0" width="${band}" height="${height}" fill="${fill}"/>`
        : `<rect x="0" y="${offset}" width="${width}" height="${band}" fill="${fill}"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${bands}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * A display attachment with sensible PNG defaults. Pass `overrides` for the
 * fields a test actually cares about.
 */
export function makeDisplayAttachment(
  overrides: Partial<DisplayAttachment> = {},
): DisplayAttachment {
  const id = overrides.id ?? "att-1";
  return {
    id,
    filename: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1_024,
    previewUrl: null,
    ...overrides,
  };
}

/** `count` distinct image attachments, named `photo-<i>.png`. */
export function makeImageAttachments(count: number): DisplayAttachment[] {
  return Array.from({ length: count }, (_, index) =>
    makeDisplayAttachment({
      id: `img-${index}`,
      filename: `photo-${index}.png`,
      previewUrl: `https://example.com/photo-${index}.png`,
    }),
  );
}

/**
 * `count` image attachments carrying a real decodable preview, so stories
 * render actual thumbnails instead of the icon fallback.
 */
export function makePreviewableImages(count: number): DisplayAttachment[] {
  return Array.from({ length: count }, (_, index) =>
    makeDisplayAttachment({
      id: `img-${index}`,
      filename: `slide-${String(index + 1).padStart(2, "0")}.png`,
      sizeBytes: 184_320 + index * 4_096,
      previewUrl: SAMPLE_PREVIEWS[index % SAMPLE_PREVIEWS.length]!,
    }),
  );
}

/** A mixed media / non-media set covering each icon fallback kind. */
export function makeMixedAttachments(): DisplayAttachment[] {
  return [
    makeImageAttachments(1)[0]!,
    makeDisplayAttachment({
      id: "deck-1",
      filename: "deck.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      sizeBytes: 4_096,
    }),
    makeDisplayAttachment({
      id: "report-1",
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2_048,
    }),
    makeDisplayAttachment({
      id: "bundle-1",
      filename: "bundle.zip",
      mimeType: "application/zip",
      sizeBytes: 8_192,
    }),
  ];
}
