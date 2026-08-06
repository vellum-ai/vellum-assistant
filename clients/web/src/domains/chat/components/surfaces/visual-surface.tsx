import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { handleAppViewerAction } from "@/domains/chat/app-viewer-actions";
import type { Surface } from "@/domains/chat/types/types";
import { useDocumentTheme } from "@/hooks/use-document-theme";
import { useWidgetFontCss } from "@/hooks/use-widget-font-css";
import { useWidgetTokenStyle } from "@/hooks/use-widget-token-style";
import { openExternalUrl } from "@/runtime/browser";
import {
  injectWidgetBridge,
  isRelayableExternalHref,
} from "@/utils/sandbox-bridge";

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

/** Stable 32-bit hash of a string, used to remount the iframe when the document
 *  it renders changes. */
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
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
 *
 * The frame gets no popup tokens, so every outbound link arrives here as a
 * `vellum_open_link` relay the host opens after checking its scheme. A popup
 * is a top-level navigation that the embedder's `frame-src` cannot constrain,
 * so routing links through the host is what keeps the frame's only egress
 * under host control.
 *
 * That relay is a known, accepted one-click egress path, and the activation
 * gate below does not close it. `navigator.userActivation` reports that the
 * user clicked *somewhere* in the frame, not that they clicked a link: widget
 * script can wait for any click, then post its own `vellum_open_link` with the
 * frameId it already knows and a URL carrying conversation-derived data. The
 * host cannot tell that message apart from one the injected anchor
 * interceptor sent, because both originate in the same frame.
 *
 * Nothing here can distinguish them. Closing it means either refusing to open
 * frame-chosen URLs at all (a visual is a self-contained illustration, so
 * links are arguably outside its contract) or confirming the destination with
 * the user first. Both are product decisions rather than fixes, and the path
 * is no worse than the popup channel it replaces. Treat the surface as able to
 * exfiltrate on any click the user makes inside it, and do not add capability
 * here on the assumption that the activation gate is a security boundary.
 */
export function VisualSurface({ surface }: { surface: Surface }) {
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const theme = useDocumentTheme();
  const fontCss = useWidgetFontCss();
  // Resolved off the live document, and re-probed until the host's stylesheet
  // has applied — a token-less snapshot would render an unthemed widget.
  const tokenStyle = useWidgetTokenStyle(theme);

  const data = surface.data as VisualSurfaceData | undefined;
  const html = typeof data?.html === "string" ? data.html : "";
  const frameId = surface.surfaceId;

  const srcDoc = useMemo(
    () => injectWidgetBridge(html, frameId, tokenStyle + fontCss),
    [html, frameId, fontCss, tokenStyle],
  );

  // Keyed on the exact document the frame renders, so every input baked into
  // `srcdoc` (markup, theme tokens, inlined fonts) remounts it. React reuses an
  // iframe element across `srcDoc` changes, and a reused frame keeps the old
  // document's scroll and script state — hashing the document itself is what
  // makes "srcdoc changed" and "frame remounted" the same event.
  const iframeKey = `visual-${frameId}-${hashString(srcDoc)}`;

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
        return;
      }
      if (msg.type === "vellum_open_link") {
        // Stops markup that phones home on load or in a loop, and nothing
        // more: an activation says the user clicked somewhere in the frame,
        // not that they clicked this link. See the accepted one-click egress
        // path in the component docstring before treating this as a boundary.
        if (!navigator.userActivation?.isActive) {
          return;
        }
        if (!isRelayableExternalHref(msg.href)) {
          return;
        }
        void openExternalUrl(msg.href.trim());
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
        sandbox="allow-scripts"
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
