import { motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { ChatComposer } from "@/domains/chat/components/chat-composer/chat-composer";

import { TourNarration } from "./tour-narration";
import { TOUR_COMPOSER, type TourStep } from "./tour-steps";

interface TourOverlayProps {
  assistantId: string | null;
  /** The stop currently being showcased; null between stops (text fades). */
  step: TourStep | null;
  /** True while the tour sits on the intro beat — no backdrop at all; the
   *  full-page flood underneath supplies the color. */
  onIntroBeat: boolean;
  /** Navigation cluster rendered by the narration below its text. */
  controls?: ReactNode;
}

/**
 * The tour's full-screen takeover: a fixed overlay covering the entire app
 * while the tour runs, shaped like the chat itself. The walk's beats blank
 * the transcript area (the sidebar stays fully visible beside it) and
 * rebuild the chat's anatomy over it: the narration typewrites where the
 * conversation's messages live, and the REAL composer component sits in its
 * usual spot at the bottom — inert, purely scenery, and the target the
 * finale beat floods. The intro beat renders none of that: the full-page
 * flood (portaled underneath at z-61) provides the color, and the flooded
 * nav targets portal in above at z-64.
 */
export function TourOverlay({
  assistantId,
  step,
  onIntroBeat,
  controls,
}: TourOverlayProps) {
  /** Backdrop's left edge — flush against the revealed sidebar. */
  const [clearLeft, setClearLeft] = useState(0);
  /** Backdrop's top edge — flush under the header, whose controls stay
   *  visible through the walk. */
  const [clearTop, setClearTop] = useState(0);
  /** The narration column's top — the side menu's top edge, so the step
   *  title aligns with the top of the menu panel. */
  const [columnTop, setColumnTop] = useState(0);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);

  // The sidebar bounces in mid-tour, so these edges are re-measured on
  // every beat (and window resizes), not once.
  useEffect(() => {
    if (onIntroBeat) {
      setClearLeft(0);
      setClearTop(0);
      setColumnTop(0);
      return;
    }
    const update = () => {
      const header = document.querySelector<HTMLElement>("header");
      setClearTop(header ? header.getBoundingClientRect().bottom : 0);

      const menu = document.querySelector<HTMLElement>("#chat-side-menu");
      if (!menu) {
        setClearLeft(0);
        setColumnTop(0);
        return;
      }
      const rect = menu.getBoundingClientRect();
      const innerWidth =
        menu.firstElementChild?.getBoundingClientRect().width ?? 0;
      setClearLeft(rect.left + Math.max(rect.width, innerWidth));
      setColumnTop(rect.top);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [onIntroBeat, step]);

  return createPortal(
    <div className="fixed inset-0 z-[62]">
      {!onIntroBeat ? (
        <motion.div
          aria-hidden
          className="absolute right-0 bottom-0"
          style={{
            left: clearLeft,
            top: clearTop,
            background: "var(--surface-base)",
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
        />
      ) : null}
      {/* While the composer beat holds the stage, the sidebar recedes too —
          a translucent wash of the base surface over its whole panel. */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0"
        style={{
          width: clearLeft,
          top: clearTop,
          background: "var(--surface-base)",
        }}
        initial={{ opacity: 0 }}
        animate={{
          opacity: !onIntroBeat && step?.id === TOUR_COMPOSER.id ? 0.6 : 0,
        }}
        transition={{ duration: 0.3 }}
      />
      <div
        className="absolute right-0 bottom-0 flex flex-col"
        style={{
          left: onIntroBeat ? 0 : clearLeft,
          top: onIntroBeat ? 0 : columnTop,
        }}
      >
        <div className="min-h-0 flex-1">
          <TourNarration
            assistantId={assistantId}
            step={step}
            variant={onIntroBeat ? "intro" : "top"}
            controls={controls}
          />
        </div>
        {!onIntroBeat ? (
          // The real composer in its real spot — inert scenery the finale
          // beat floods. `data-tour-composer` disambiguates it from the
          // app's own (hidden) composer for the flood's measurement.
          <div
            data-tour-composer="true"
            className="pointer-events-none shrink-0 px-4 pb-4 sm:px-6"
            // Dimmed until its own beat — each step pulls everything else
            // out of the attention field.
            style={{
              opacity: step?.id === TOUR_COMPOSER.id ? 1 : 0.4,
              transition: "opacity 300ms ease",
            }}
          >
            <div className="mx-auto w-full max-w-[var(--chat-max-width)]">
              <ChatComposer
                onSubmit={(event) => event.preventDefault()}
                inputRef={composerInputRef}
                typingDisabled={false}
                sendDisabled
                onAddAttachmentFiles={() => {}}
                onStopGenerating={() => {}}
                isAssistantBusy={false}
                assistantId={assistantId}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
