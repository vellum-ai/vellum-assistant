const BLUR_RADIUS_PX = 60;
/** Over-scan per side is 2x the blur radius, so the layer grows by 4x on each axis. */
const OVERSCAN_PX = BLUR_RADIUS_PX * 2;

/**
 * Decorative backdrop for the provisioning takeover: the avatar image blurred
 * behind a scrim, so the takeover's ground picks up the avatar's color.
 */
export function TakeoverBackdrop({ imageUrl }: { imageUrl: string }) {
  return (
    <div
      aria-hidden
      data-testid="takeover-backdrop"
      className="provision-backdrop-reveal pointer-events-none absolute inset-0 overflow-hidden"
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
