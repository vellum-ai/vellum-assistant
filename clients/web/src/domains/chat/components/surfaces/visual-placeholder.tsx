/**
 * Stands in for an inline visual while `visualize_render` is still running.
 *
 * A visual replaces prose rather than annotating it, so the generic activity
 * chip would read as unrelated machinery next to the text it belongs to. The
 * shimmer occupies roughly the space the widget will claim, so the transcript
 * settles instead of jumping when the surface arrives.
 */
export function VisualPlaceholder() {
  return (
    <div
      className="skeleton-shimmer flex h-[120px] w-full items-center justify-center rounded-lg"
      role="status"
    >
      <span className="text-body-small-default text-[var(--content-quiet)]">
        Sketching a visual…
      </span>
    </div>
  );
}
