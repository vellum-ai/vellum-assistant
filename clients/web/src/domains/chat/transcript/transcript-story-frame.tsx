import type { CSSProperties, ReactNode } from "react";

/**
 * A sized chat surface for transcript stories. `Transcript` fills its
 * `h-full` parent, so the frame gives it the bounded box the app's chat
 * layout would. Shared by every story file that mounts a transcript, so the
 * framing stays one treatment.
 */
export function TranscriptStoryFrame({
  height = 720,
  children,
}: {
  height?: CSSProperties["height"];
  children: ReactNode;
}) {
  return (
    <div
      style={{
        height,
        width: 780,
        overflow: "hidden",
        borderRadius: 12,
        border: "1px solid var(--border-base)",
        background: "var(--surface-base)",
      }}
    >
      {children}
    </div>
  );
}
