/**
 * Stand-ins for the SF Symbols and the brand mark the widgets draw.
 *
 * The real cards use `Image(systemName:)` and the `VellumV` asset, neither of
 * which exists in a browser. These are hand-drawn approximations at the same
 * nominal point size, close enough to judge layout and weight by and not close
 * enough to judge the symbols themselves; see the fidelity note in the stories.
 *
 * @see clients/ios/App/VoiceActivity/Widgets/WidgetActionControls.swift
 */

interface GlyphProps {
  /** The point size the Swift passes to `.font(.system(size:))`. */
  size: number;
  color: string;
}

/** `camera.fill`. The lens is a hole, so the glyph reads on any fill. */
export function CameraGlyph({ size, color }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M9 3.6h6l1.1 1.9H19a2.4 2.4 0 0 1 2.4 2.4v9.6A2.4 2.4 0 0 1 19 19.9H5a2.4 2.4 0 0 1-2.4-2.4V7.9A2.4 2.4 0 0 1 5 5.5h2.9L9 3.6Zm3 5.5a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"
      />
    </svg>
  );
}

/** `waveform` */
export function WaveformGlyph({ size, color }: GlyphProps) {
  const bars = [6, 12, 20, 12, 6];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={color}
    >
      {bars.map((height, index) => (
        <rect
          key={index}
          x={2.6 + index * 4.6}
          y={12 - height / 2}
          width="2.2"
          height={height}
          rx="1.1"
        />
      ))}
    </svg>
  );
}

/**
 * `bubble.left` / `bubble.left.fill`. The outline is what a white card draws
 * and the fill is what a card painted in the assistant's color draws.
 */
export function BubbleGlyph({
  size,
  color,
  filled,
}: GlyphProps & { filled: boolean }) {
  const d =
    "M12 3.4c-4.9 0-8.9 3.1-8.9 7 0 2.2 1.3 4.2 3.3 5.5v3.4a.5.5 0 0 0 .8.4l3-2.2c.6.1 1.2.1 1.8.1 4.9 0 8.9-3.1 8.9-7s-4-7.2-8.9-7.2Z";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={filled ? color : "none"}
      stroke={filled ? "none" : color}
      strokeWidth={filled ? 0 : 1.7}
    >
      <path d={d} strokeLinejoin="round" />
    </svg>
  );
}

/** `ellipsis` */
export function EllipsisGlyph({ size, color }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={color}
    >
      <circle cx="5" cy="12" r="2.1" />
      <circle cx="12" cy="12" r="2.1" />
      <circle cx="19" cy="12" r="2.1" />
    </svg>
  );
}
