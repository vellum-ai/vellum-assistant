import { createElement } from "react";

import { FileTerminal, SquareTerminal, type LucideIcon } from "lucide-react";

/**
 * The lucide icon for a background tool, keyed off its tool name. `host_bash`
 * runs on the desktop host (file-terminal); `bash` runs in the daemon sandbox
 * (square-terminal). Returns the icon component itself, for callers that need
 * to pass it as a prop (e.g. `DetailShell`'s `Glyph`).
 */
export function backgroundTaskGlyph(toolName: string): LucideIcon {
  return toolName === "host_bash" ? FileTerminal : SquareTerminal;
}

/**
 * Rendered background-tool glyph for inline use (card / pill). A stable
 * module-level component so the icon isn't recreated each render — `createElement`
 * (not a render-local `<Glyph />`) keeps the tool-keyed icon out of the render body.
 */
export function BackgroundTaskGlyph({
  toolName,
  className,
}: {
  toolName: string;
  className?: string;
}) {
  return createElement(backgroundTaskGlyph(toolName), {
    className,
    "aria-hidden": true,
  });
}
