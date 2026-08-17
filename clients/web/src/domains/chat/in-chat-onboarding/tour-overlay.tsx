import { motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { CHAT_LAYOUT_HEADER_SELECTOR } from "@/domains/chat/chat-layout-header";
import { ChatComposer } from "@/domains/chat/components/chat-composer/chat-composer";
import { type VoiceInputButtonHandle } from "@/domains/chat/components/voice-input-button";

import { TourNarration } from "./tour-narration";
import { TOUR_COMPOSER, TOUR_VOICE, type TourStep } from "./tour-steps";

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
 * usual spot at the bottom, inert and purely scenery. The chat beat floods it
 * whole; the finale lands the avatar on the voice button within it. The intro
 * beat renders none of that: the full-page flood (portaled underneath at
 * z-61) provides the color, and the flooded nav targets portal in above at
 * z-64.
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
  // The chat beat floods the whole composer and the finale lands the avatar on
  // the voice button inside it, so the composer holds the stage across both.
  const composerHoldsStage =
    step?.id === TOUR_COMPOSER.id || step?.id === TOUR_VOICE.id;
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Supplying both voice props is what makes the scenery composer render its
  // voice controls at all (`showVoiceInput` tests for exactly this pair), and
  // the finale beat lands the avatar on the live-voice button among them.
  // Inert like the rest of the scenery: the wrapper below is
  // `pointer-events-none`, so the handle is never driven and the transcript
  // callback never fires.
  const sceneryVoiceInputRef = useRef<VoiceInputButtonHandle | null>(null);

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
      // The chat layout's own header. A bare `header` tag selector matches
      // whichever `<header>` comes first in the document, which the detail
      // panels also render.
      const header = document.querySelector<HTMLElement>(
        CHAT_LAYOUT_HEADER_SELECTOR,
      );
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
          opacity: !onIntroBeat && composerHoldsStage ? 0.6 : 0,
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
            // Dimmed until its own beats, since each step pulls everything
            // else out of the attention field.
            style={{
              opacity: composerHoldsStage ? 1 : 0.4,
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
                voiceInputRef={sceneryVoiceInputRef}
                onVoiceTranscript={() => {}}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
