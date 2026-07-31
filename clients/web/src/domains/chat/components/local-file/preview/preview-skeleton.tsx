import type { ReactNode } from "react";

/** Relative widths of the placeholder lines, so the block reads as prose. */
const LINE_WIDTHS = ["w-2/5", "w-full", "w-11/12", "w-4/5", "w-3/4"];

/** Placeholder shown while an OOXML package is being unzipped and parsed. */
export function PreviewSkeleton(): ReactNode {
  return (
    <div
      role="status"
      aria-label="Loading preview"
      className="flex flex-col gap-3 p-1"
    >
      {LINE_WIDTHS.map((width) => (
        <span
          key={width}
          className={`h-4 animate-pulse rounded bg-[var(--surface-lift)] ${width}`}
        />
      ))}
    </div>
  );
}
