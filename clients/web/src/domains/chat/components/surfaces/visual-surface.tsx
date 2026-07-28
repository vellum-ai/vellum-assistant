import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { handleAppViewerAction } from "@/domains/chat/app-viewer-actions";
import type { Surface } from "@/domains/chat/types/types";
import { useDocumentTheme } from "@/hooks/use-document-theme";
import { useWidgetFontCss } from "@/hooks/use-widget-font-css";
import { injectWidgetBridge } from "@/utils/sandbox-bridge";
import { buildWidgetStyle } from "@/utils/widget-tokens";

interface VisualSurfaceData {
  html?: string;
  height?: number;
}

/** Bounds on the widget-reported height, so a runaway report can't take over
 *  the transcript or collapse the frame to nothing. */
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 1400;
const DEFAULT_HEIGHT = 300;

function clampHeight(height: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height)));
}

/** Stable 32-bit hash of the widget HTML, used to remount the iframe when the
 *  assistant re-renders a visual with different content. */
function hashHtml(html: string): number {
  let hash = 0;
  for (let i = 0; i < html.length; i++) {
    hash = ((hash << 5) - hash + html.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Renders a `visual` surface — a self-contained illustration (SVG diagram,
 * styled table, small interactive explainer) the assistant emits inline.
 *
 * The HTML is untrusted, so it runs inside a `srcdoc` iframe sandboxed without
 * `allow-same-origin`. Two things make it read as native rather than as an
 * embedded document: the host's resolved design tokens and brand fonts are
 * injected as a `:root` block, and the widget reports its own content height
 * so the frame has no scrollbar and no dead space.
 *
 * The widget can hand a follow-up back to the assistant via `sendPrompt(text)`.
 * The parent honors it only under an active user activation and routes it
 * through the same `?prompt=` auto-send pathway the app viewer uses, so the
 * relay lands as a real user message.
 */
export function VisualSurface({ surface }: { surface: Surface }) {
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const theme = useDocumentTheme();
  const fontCss = useWidgetFontCss();

  const data = surface.data as VisualSurfaceData | undefined;
  const html = typeof data?.html === "string" ? data.html : "";
  const frameId = surface.surfaceId;

  // The iframe is keyed on everything baked into `srcdoc`: React reuses an
  // iframe element across `srcDoc` changes, and a reused frame keeps the old
  // document's scroll and script state.
  const iframeKey = `visual-${frameId}-${hashHtml(html)}-${theme}-${fontCss.length}`;

  // The token values are resolved off the live document, so `theme` is both an
  // input to the snapshot and the signal that it is stale.
  const srcDoc = useMemo(
    () => injectWidgetBridge(html, frameId, buildWidgetStyle(theme) + fontCss),
    [html, frameId, fontCss, theme],
  );

  const initialHeight = clampHeight(
    typeof data?.height === "number" && Number.isFinite(data.height)
      ? data.height
      : DEFAULT_HEIGHT,
  );
  // Height belongs to the mounted document, so a remount restarts from the
  // surface's declared height instead of inheriting the previous widget's.
  const [heightState, setHeightState] = useState({
    key: iframeKey,
    height: initialHeight,
  });
  if (heightState.key !== iframeKey) {
    setHeightState({ key: iframeKey, height: initialHeight });
  }

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || msg.frameId !== frameId) {
        return;
      }
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      if (msg.type === "vellum_widget_height") {
        const reported = Number(msg.height);
        if (!Number.isFinite(reported)) {
          return;
        }
        const next = clampHeight(reported);
        setHeightState((prev) =>
          prev.height === next ? prev : { ...prev, height: next },
        );
        return;
      }
      if (msg.type === "vellum_widget_prompt") {
        // A sandboxed widget can read its own frameId and post without a
        // click, so the relay is gated on a transient user activation the
        // same way `vellum_open_link` is.
        if (!navigator.userActivation?.isActive) {
          return;
        }
        const prompt = typeof msg.prompt === "string" ? msg.prompt.trim() : "";
        if (!prompt) {
          return;
        }
        handleAppViewerAction({ navigate, isMobile: false }, "relay_prompt", {
          prompt,
        });
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [frameId, navigate]);

  if (!html) {
    return null;
  }

  return (
    <div className="w-full overflow-hidden rounded-lg">
      <iframe
        ref={iframeRef}
        key={iframeKey}
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        title={surface.title || "Visual"}
        style={{
          width: "100%",
          height: `${heightState.height}px`,
          border: "none",
          display: "block",
        }}
      />
    </div>
  );
}
