const BLUR_RADIUS_PX = 60;
// Over-scan each side by 2x the blur radius so the blurred layer never samples
// past the image into transparency; each axis therefore grows by 4x the radius.
const OVERSCAN_PX = BLUR_RADIUS_PX * 2; // 120px per side

/**
 * Decorative backdrop for the provisioning takeover: the avatar image blurred
 * behind a scrim, so the takeover's ground picks up the avatar's color.
 *
 * `animateIn` fades the layer in over `--provision-reveal` as the image
 * decodes — right where the backdrop mounts cold. Pass false where an ancestor
 * already drives the fade (the takeover-exit sheet), so the two opacity ramps
 * don't multiply.
 */
export function TakeoverBackdrop({
  imageUrl,
  animateIn = true,
}: {
  imageUrl: string;
  animateIn?: boolean;
}) {
  return (
    <div
      aria-hidden
      data-testid="takeover-backdrop"
      className={`pointer-events-none absolute inset-0 overflow-hidden${
        animateIn ? " provision-avatar-reveal" : ""
      }`}
    >
      {/* `blur()` samples transparent outside the element, so the layer
          over-scans the container by an absolute amount tied to the radius —
          otherwise the edges fade to the ground color on narrow surfaces. */}
      <img
        src={imageUrl}
        alt=""
        decoding="async"
        draggable={false}
        className="absolute left-1/2 top-1/2 max-w-none -translate-x-1/2 -translate-y-1/2 object-cover object-center"
        style={{
          filter: `blur(${BLUR_RADIUS_PX}px)`,
          width: `calc(100% + ${OVERSCAN_PX * 2}px)`,
          height: `calc(100% + ${OVERSCAN_PX * 2}px)`,
        }}
      />
      <div className="absolute inset-0 bg-black/55" />
    </div>
  );
}
