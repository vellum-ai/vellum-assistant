/**
 * The sleep stage: the assistant, eyes half shut, filling the conversation
 * page while it is asleep or waking up, and opening its eyes when it comes
 * back.
 *
 * A one-line banner is the right size for "your assistant is upgrading" and
 * the wrong size for the one state where the page below it cannot be used at
 * all. So while the assistant is sleeping or waking, the conversation page
 * shows whose sleep it is instead: the user's own avatar, at the size of the
 * page, with its lids down. The banner stands down for the duration (see
 * `StatusBanner`, which reads `visible` off the shared store) so the status is
 * stated once. `SleepStageView` draws it; this component decides when.
 *
 * **It is an arrival screen, not a status light.** The stage plays only when
 * the sleep is what the user has just walked into: the page loaded on a
 * sleeping assistant, or they came back to a tab that fell asleep while they
 * were away. Someone already working in the tab whose assistant drops out
 * (a network blip reads as sleep) keeps their conversation on screen and gets
 * the banner. So arming is latched at the moment the sleep is first seen, and
 * a resume on the `online` signal is deliberately not an arrival: that is the
 * network coming back, not the user.
 *
 * **Fullish, not fullscreen.** The stage is an `absolute inset-0` layer inside
 * the conversation's `<main>`, the same placement the desktop voice room
 * takes. The sidenav, the header and the window chrome stay put and stay
 * usable: this covers the thread, which is the part that is waiting. It sits
 * at `z-30`, over the thread's own layered controls, and stands down entirely
 * while the voice room, a takeover of the same box, is up. `ChatLayout` makes
 * the covered thread `inert` for as long as the stage is drawn.
 *
 * **A close button hands the page back.** The stage's surface is inert, so a
 * stray click on the conversation it covers cannot dismiss it by accident;
 * the close button in its corner can, and the banner then returns to carrying
 * the status. The dismissal is scoped to that assistant's current sleep.
 *
 * **Waking is played, not cut.** When the assistant comes back while the stage
 * is up, the lids open, the copy says so for a beat, and the stage fades to
 * the conversation underneath. That outro runs off a phase transition this
 * component actually witnessed, so an assistant that was never on screen
 * asleep does not announce that it woke.
 *
 * The eyes are the avatar's own eye art, so the creature asleep on the page is
 * the one the user made. An assistant with an uploaded image has no eye art to
 * close, so its image stands in, dimmed; an assistant with neither leaves the
 * line of copy alone on the stage.
 *
 * To see it without an assistant that will actually sleep, drive it from the
 * console: `_vellumDebug.flags.forceSleepStage("sleeping" | "waking" | "woke")`,
 * and `forceSleepStage(null)` to hand the page back.
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";

import {
  useAssistantSleepPhase,
  type AssistantSleepPhase,
} from "@/components/status-banner";
import {
  resolveSleepStageEyes,
  SleepStageView,
  WOKE_SEQUENCE_MS,
  type SleepStageScene,
} from "@/domains/chat/components/sleep-stage-scene";
import { useIsVoiceRoomVisible } from "@/domains/chat/voice/voice-room/use-is-voice-room-visible";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useTranslation } from "@/i18n";
import { readLastSeenAvatar } from "@/lib/avatar-last-seen-cache";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useAssistantSleepStageStore } from "@/stores/assistant-sleep-stage-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { isConversationChatPath } from "@/utils/routes";

/**
 * How long after an arrival a sleep still counts as one the user walked into.
 * Wide enough to cover a cold load resolving auth, org and the first status
 * poll before the sleep is even known; short enough that a sleep an hour into
 * a working session is not dressed up as an arrival.
 */
let arrivalWindowMs = 20_000;

/**
 * Override the arrival window. Test-only seam so specs can exercise the
 * unarmed path without real-time waits; never call from production code.
 * @internal
 */
export function __setArrivalWindowMsForTesting(ms: number): void {
  arrivalWindowMs = ms;
}

export function AssistantSleepStage() {
  const { t } = useTranslation("chat");
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

  const wasDismissed = useAssistantSleepStageStore.use.dismissed();
  const dismissedAssistantId =
    useAssistantSleepStageStore.use.dismissedAssistantId();
  const forcedScene = useAssistantSleepStageStore.use.forcedScene();
  const setVisible = useAssistantSleepStageStore.use.setVisible();
  const dismissStage = useAssistantSleepStageStore.use.dismiss();
  const reset = useAssistantSleepStageStore.use.reset();

  // The dismissal belongs to the assistant it was aimed at: another assistant
  // that is also asleep gets its own stage, while a remount of this one (the
  // window crossing the mobile breakpoint moves the stage between
  // `ChatLayout`'s branches) stays dismissed.
  const dismissed = wasDismissed && dismissedAssistantId === assistantId;

  // The last time the user arrived: this mount is a page load, and a
  // foreground edge is a return to the tab. Not `signal: "online"`, which is
  // the network reconnecting under a user who never left.
  // Stamped in an effect rather than at `useRef` init: reading the clock
  // during render is impure, and this effect is declared before the arming
  // one so the timestamp is already there when the first phase is judged.
  const arrivedAtRef = useRef(0);
  useEffect(() => {
    arrivedAtRef.current = Date.now();
  }, []);
  const [armed, setArmed] = useState(false);
  useBusSubscription("app.resume", ({ signal }) => {
    if (signal === "online") {
      return;
    }
    arrivedAtRef.current = Date.now();
    if (phase !== null) {
      setArmed(true);
    }
  });
  // Latched when the sleep is first seen, so a sleep that begins later in the
  // same session stays with the banner however long the user then sits there.
  useEffect(() => {
    if (phase === null) {
      setArmed(false);
      return;
    }
    if (Date.now() - arrivedAtRef.current <= arrivalWindowMs) {
      setArmed(true);
    }
  }, [phase]);

  const sleepVisible =
    onConversationPage &&
    !voiceRoomVisible &&
    phase !== null &&
    armed &&
    !dismissed;

  // The waking outro belongs to a sleep this component actually showed:
  // an assistant that woke while the stage was never up has nothing to
  // announce.
  const showedThisSleepRef = useRef(false);
  useEffect(() => {
    if (sleepVisible) {
      showedThisSleepRef.current = true;
    }
  }, [sleepVisible]);

  const [woke, setWoke] = useState(false);
  const previousPhaseRef = useRef<AssistantSleepPhase | null>(null);
  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    if (phase !== null) {
      return;
    }
    if (previous !== null && showedThisSleepRef.current && !dismissed) {
      setWoke(true);
    }
    showedThisSleepRef.current = false;
  }, [phase, dismissed]);

  useEffect(() => {
    if (!woke) {
      return;
    }
    const timer = setTimeout(() => setWoke(false), WOKE_SEQUENCE_MS);
    return () => clearTimeout(timer);
  }, [woke]);

  const scene: SleepStageScene | null = !onConversationPage
    ? null
    : (forcedScene ??
      (sleepVisible ? phase : null) ??
      (woke && !voiceRoomVisible ? "woke" : null));

  useEffect(() => {
    setVisible(scene !== null);
    return () => setVisible(false);
  }, [scene, setVisible]);

  // A dismissal lasts as long as the sleep it was aimed at, and only that
  // assistant's waking clears it: visiting an assistant that is awake reports
  // no phase, and must not end a sleep somewhere else.
  useEffect(() => {
    if (phase === null && dismissedAssistantId === assistantId) {
      reset();
    }
  }, [phase, dismissedAssistantId, assistantId, reset]);

  const setForcedScene = useAssistantSleepStageStore.use.setForcedScene();
  const dismiss = useCallback(() => {
    setWoke(false);
    // A pinned scene outranks the sleep itself, so a click has to clear the
    // pin as well or the stage cannot be dismissed while it is on.
    setForcedScene(null);
    dismissStage(assistantId);
  }, [dismissStage, setForcedScene, assistantId]);

  // Traits from the assistant when it is reachable, else the last ones this
  // device saw it wearing. On a cold load the thing that serves them is the
  // thing asleep, and defaulting to the catalog's first creature would put a
  // character the user never made on the page during the one state this
  // screen exists for. Only a character is recovered: an uploaded image would
  // mean a blob URL to own, and the copy alone carries that case.
  const lastSeen = useQuery({
    queryKey: ["assistant-sleep-stage", "last-seen-avatar", assistantId],
    queryFn: () => readLastSeenAvatar(assistantId!),
    // Deliberately not pinned: the record is deleted when the user removes
    // their avatar, and nothing invalidates this key, so a later sleep in the
    // same session re-reads rather than redrawing a character that is gone.
    enabled:
      scene !== null && Boolean(assistantId) && !traits && !customImageUrl,
  });
  const effectiveTraits =
    traits ??
    (lastSeen.data?.kind === "character" ? lastSeen.data.traits : null);

  // The recovered image is a blob, so the object URL is owned here and lives
  // exactly as long as the render that shows it.
  const lastSeenBlob =
    lastSeen.data?.kind === "image" ? lastSeen.data.blob : null;
  const [lastSeenImageUrl, setLastSeenImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!lastSeenBlob) {
      setLastSeenImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(lastSeenBlob);
    setLastSeenImageUrl(url);
    return () => {
      setLastSeenImageUrl(null);
      URL.revokeObjectURL(url);
    };
  }, [lastSeenBlob]);
  const imageUrl = customImageUrl ?? lastSeenImageUrl;

  // The catalog is bundled, so the eyes still draw while the assistant that
  // serves `/avatar/character-components` is the thing asleep. The traits are
  // not: with none known (an avatar-less assistant, or nothing recorded for
  // this one) the stage is the line of copy alone, because the catalog's
  // first creature is a character the user never chose.
  const eyes = useMemo(() => {
    // Measuring the art parses every eye path, so it waits until there is a
    // stage to draw: every conversation mounts this component, and almost
    // none of them are asleep.
    if (scene === null || !effectiveTraits) {
      return null;
    }
    return resolveSleepStageEyes(
      components ?? BUNDLED_COMPONENTS,
      effectiveTraits,
      imageUrl,
    );
  }, [scene, components, effectiveTraits, imageUrl]);

  if (scene === null) {
    return null;
  }

  return (
    <SleepStageView
      scene={scene}
      eyes={eyes}
      imageUrl={imageUrl}
      line={sceneLine(t, scene, assistantName)}
      dismissLabel={t("assistantSleepStage.dismissLabel")}
      onDismiss={dismiss}
    />
  );
}

type TranslateChat = ReturnType<typeof useTranslation<"chat">>["t"];

/**
 * The line under the eyes. Named and unnamed are separate messages rather than
 * a name substituted into one: a language that inflects around the subject can
 * only write "your assistant is waking up" as its own sentence.
 */
function sceneLine(
  t: TranslateChat,
  scene: SleepStageScene,
  name: string | null,
): string {
  if (scene === "woke") {
    return name
      ? t("assistantSleepStage.wokeNamed", { name })
      : t("assistantSleepStage.woke");
  }
  if (scene === "waking") {
    return name
      ? t("assistantSleepStage.wakingNamed", { name })
      : t("assistantSleepStage.waking");
  }
  return name
    ? t("assistantSleepStage.sleepingNamed", { name })
    : t("assistantSleepStage.sleeping");
}
