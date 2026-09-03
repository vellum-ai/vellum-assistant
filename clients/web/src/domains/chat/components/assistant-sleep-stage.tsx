/**
 * The sleep stage: the assistant, eyes half shut, filling the conversation
 * page while it is asleep or waking up.
 *
 * A one-line banner is the right size for "your assistant is upgrading" and
 * the wrong size for the one state where the page below it cannot be used at
 * all. So while the assistant is sleeping or waking, the conversation page
 * shows whose sleep it is instead: the user's own avatar, at the size of the
 * page, with its lids down. The banner stands down for the duration (see
 * `StatusBanner`, which reads `visible` off the shared store) so the status is
 * stated once.
 *
 * **Fullish, not fullscreen.** The stage is an `absolute inset-0` layer inside
 * the conversation's `<main>`, the same placement the desktop voice room
 * takes. The sidenav, the header and the window chrome stay put and stay
 * usable: this covers the thread, which is the part that is waiting. It sits
 * at `z-30`, over the thread's own layered controls (the scroll-to-latest
 * button, the attachment drag overlay), and stands down entirely while the
 * voice room, a takeover of the same box, is up. `ChatLayout` makes the
 * covered thread `inert` for as long as the stage is drawn, so what is behind
 * it is out of the tab order and the accessibility tree rather than merely
 * out of reach of the pointer.
 *
 * **Clicking it hands the page back.** The whole stage is a button; one click
 * dismisses it and the banner returns to carrying the status, so nobody is
 * stuck behind it while the assistant takes its time. The dismissal is scoped
 * to this sleep: once the assistant is neither sleeping nor waking the stage
 * resets, and the next sleep draws it again.
 *
 * The eyes are the avatar's own eye art (the builder's eye style, and its
 * color for the lids), so the creature asleep on the page is the one the user
 * made. An assistant with an uploaded image has no eye art to close, so its
 * image stands in, dimmed; an assistant with neither leaves the line of copy
 * alone on the stage.
 */

import { useQuery } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo } from "react";
import { useLocation } from "react-router";

import {
  useAssistantSleepPhase,
  type AssistantSleepPhase,
} from "@/components/status-banner";
import { useIsVoiceRoomVisible } from "@/domains/chat/voice/voice-room/use-is-voice-room-visible";
import { resolveVoiceRoomLook } from "@/domains/chat/voice/voice-room/voice-room-eyes";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";
import { readLastSeenAvatar } from "@/lib/avatar-last-seen-cache";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useAssistantSleepStageStore } from "@/stores/assistant-sleep-stage-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { tightPathBBox, unionBBox, type BBox } from "@/utils/eye-bbox";
import { isConversationChatPath } from "@/utils/routes";

/**
 * How much of the eye the lid covers, at rest and at the bottom of a drift.
 * An assistant coming back up is further open than one still under: the same
 * face, a little more of it, which is the difference the two states have.
 */
const LID_REST: Record<AssistantSleepPhase, number> = {
  sleeping: 0.62,
  waking: 0.5,
};
const LID_DRIFT = 0.12;
/** One full drift of the lids, in seconds: a slow breath, not a blink. */
const LID_DRIFT_SECONDS = 4;

export function AssistantSleepStage() {
  const { t } = useTranslation("chat");
  const reduce = useReducedMotion();
  const clipId = useId();
  // Only where the chat surface itself is mounted: the `/assistant` draft and
  // an open conversation, not the inspector or the other routes under
  // `ChatLayout` (home, library, the identity pages), which have content of
  // their own worth reading while the assistant is away and keep the banner.
  const { pathname } = useLocation();
  const onConversationPage = isConversationChatPath(pathname);
  // The voice room is a takeover of the same box; it mounts after this one and
  // owns the surface while it is up.
  const voiceRoomVisible = useIsVoiceRoomVisible();
  const phase = useAssistantSleepPhase();
  const assistantName = useAssistantIdentityStore.use.name();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { components, traits, customImageUrl } =
    useAssistantAvatar(assistantId);

  const dismissed = useAssistantSleepStageStore.use.dismissed();
  const setVisible = useAssistantSleepStageStore.use.setVisible();
  const dismiss = useAssistantSleepStageStore.use.dismiss();
  const reset = useAssistantSleepStageStore.use.reset();

  const visible =
    onConversationPage && !voiceRoomVisible && phase !== null && !dismissed;

  useEffect(() => {
    setVisible(visible);
    return () => setVisible(false);
  }, [visible, setVisible]);

  // A dismissal lasts as long as the sleep it was aimed at, and belongs to the
  // assistant it was aimed at: switching to another assistant that is also
  // asleep never reports a phase of null, so the switch clears it too.
  useEffect(() => {
    if (phase === null) {
      reset();
    }
  }, [phase, reset]);
  useEffect(() => {
    reset();
  }, [assistantId, reset]);

  // Traits from the assistant when it is reachable, else the last ones this
  // device saw it wearing. On a cold load the thing that serves them is the
  // thing asleep, and defaulting to the catalog's first creature would put a
  // character the user never made on the page during the one state this
  // screen exists for. Only a character is recovered: an uploaded image would
  // mean a blob URL to own, and the copy alone carries that case.
  const lastSeen = useQuery({
    queryKey: ["assistant-sleep-stage", "last-seen-traits", assistantId],
    queryFn: async () => {
      const seen = await readLastSeenAvatar(assistantId!);
      return seen?.kind === "character" ? seen.traits : null;
    },
    enabled: visible && Boolean(assistantId) && !traits && !customImageUrl,
    staleTime: Infinity,
  });
  const effectiveTraits = traits ?? lastSeen.data ?? null;

  // The catalog is bundled, so the eyes still draw while the assistant that
  // serves `/avatar/character-components` is the thing asleep.
  const eyes = useMemo(() => {
    // Measuring the art parses every eye path, so it waits until there is a
    // stage to draw: every conversation mounts this component, and almost
    // none of them are asleep.
    if (!visible) {
      return null;
    }
    const look = resolveVoiceRoomLook(
      components ?? BUNDLED_COMPONENTS,
      effectiveTraits,
      customImageUrl,
    );
    if (!look?.art) {
      return null;
    }
    // The lid is placed as a share of the eye, so it has to be measured
    // against the ink and not against `look.art.bbox`, which is the
    // control-point box the peeking eyes frame with: `angry` is drawn with
    // control points nowhere near its curves, and a lid at half of that box
    // covers the whole eye. See `tightPathBBox`.
    const bbox = unionBBox(
      look.art.paths.map((path) => tightPathBBox(path.svgPath)),
    );
    if (bbox.w <= 0 || bbox.h <= 0) {
      return null;
    }
    const eyeArt: SleepingEyeArt = {
      paths: look.art.paths,
      bbox,
      lidColor: look.bgHex,
    };
    return eyeArt;
  }, [visible, components, effectiveTraits, customImageUrl]);

  if (!visible || phase === null) {
    return null;
  }

  const line = assistantName
    ? phase === "waking"
      ? t("assistantSleepStage.wakingNamed", { name: assistantName })
      : t("assistantSleepStage.sleepingNamed", { name: assistantName })
    : phase === "waking"
      ? t("assistantSleepStage.waking")
      : t("assistantSleepStage.sleeping");

  return (
    <motion.button
      type="button"
      onClick={dismiss}
      aria-label={t("assistantSleepStage.dismissLabel")}
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-10 rounded-xl bg-[var(--surface-base)] px-6"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduce ? 0 : 0.35 }}
    >
      {eyes ? (
        <SleepingEyes
          eyes={eyes}
          phase={phase}
          clipId={clipId}
          reduce={Boolean(reduce)}
        />
      ) : customImageUrl ? (
        <img
          src={customImageUrl}
          alt=""
          aria-hidden="true"
          className="w-[clamp(120px,20vw,200px)] rounded-full object-cover opacity-60"
        />
      ) : null}

      <span
        className="block text-center text-[28px] leading-[1.2] tracking-[0.02em] text-[var(--content-emphasised)] md:text-[36px]"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        {line}
      </span>
    </motion.button>
  );
}

/** The eye art the stage draws, plus the lid color it closes them with. */
interface SleepingEyeArt {
  paths: { svgPath: string; color: string }[];
  bbox: BBox;
  lidColor: string;
}

/**
 * The eye art with its lids down: the eyes drawn as they always are, then a
 * lid rectangle wearing the eyes' own silhouette so it closes each eye over
 * its top half and leaves the gap between them empty. The lid drifts a little
 * lower and back, which is what makes a still pair of eyes read as asleep
 * rather than as a drawing of eyes.
 */
function SleepingEyes({
  eyes,
  phase,
  clipId,
  reduce,
}: {
  eyes: SleepingEyeArt;
  phase: AssistantSleepPhase;
  clipId: string;
  reduce: boolean;
}) {
  const { bbox } = eyes;
  const restHeight = LID_REST[phase] * bbox.h;
  const deepHeight = (LID_REST[phase] + LID_DRIFT) * bbox.h;

  return (
    <svg
      aria-hidden="true"
      viewBox={`${bbox.x} ${bbox.y} ${bbox.w} ${bbox.h}`}
      className="h-auto w-[clamp(140px,26vw,240px)] shrink-0"
    >
      <defs>
        <clipPath id={clipId}>
          {eyes.paths.map((path, i) => (
            <path key={i} d={path.svgPath} />
          ))}
        </clipPath>
      </defs>
      {eyes.paths.map((path, i) => (
        <path key={i} d={path.svgPath} fill={path.color} />
      ))}
      <motion.rect
        clipPath={`url(#${clipId})`}
        x={bbox.x}
        y={bbox.y}
        width={bbox.w}
        fill={eyes.lidColor}
        initial={{ height: restHeight }}
        animate={
          reduce
            ? { height: restHeight }
            : { height: [restHeight, deepHeight, restHeight] }
        }
        transition={
          reduce
            ? { duration: 0 }
            : {
                duration: LID_DRIFT_SECONDS,
                repeat: Infinity,
                ease: "easeInOut",
              }
        }
      />
    </svg>
  );
}
