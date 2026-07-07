/**
 * Route wrapper for the research-onboarding front door.
 *
 * SPIKE — research-onboarding flow.
 *
 * Collects first/last/occupation, stages a pre-chat context whose
 * `initialMessage` is the "research me" prompt, then hands off immediately to
 * the existing `/assistant?onboarding=1` pipeline, where the standard machinery
 * hatches the assistant, mints a conversation, auto-sends the research prompt,
 * and streams the reply — rendered chrome-less by `ChatLayout` because the
 * focus flag is set.
 *
 * `beginCheckin` flips the focused overlay to its first step — the "Let's chat
 * tomorrow" Google Calendar page — which is shown WHILE the research streams in
 * behind it. So the research pass starts the instant the form is submitted; the
 * gcal step just gates when the results are revealed. The user reads the output,
 * then clicks "Continue" to drop into the full workspace on the same conversation.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { lifecycleService } from "@/assistant/lifecycle-service";
import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import { isLocalMode } from "@/lib/local-mode";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";
import { preloadBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import { DEFAULT_GROUP_ID } from "@/domains/onboarding/prechat-names";
import {
  setPendingAssistantName,
  setPendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";
import {
  buildResearchPrompt,
  type ResearchSubject,
} from "@/domains/onboarding/research-prompt";
import { shouldAdoptExistingAssistant } from "@/domains/onboarding/adopt-existing-assistant";
import { useBackgroundHatch } from "@/domains/onboarding/use-background-hatch";
import { useResearchRunner } from "@/domains/onboarding/research-runner";
import { sendResearchCorrection } from "@/domains/onboarding/send-research-correction";
import { applyPersonality } from "@/domains/onboarding/apply-personality";
import { buildLetsChatKickoffMessage } from "@/domains/onboarding/lets-chat-kickoff";
import {
  clearResearchSnapshot,
  readResearchSnapshot,
  resolveResumeStep,
  writeResearchSnapshot,
  type ResearchStep,
} from "@/domains/onboarding/research-onboarding-persistence";
import {
  emitResearchOnboardingStepCompleted,
  RESEARCH_ONBOARDING_FUNNEL_STEPS,
  type OnboardingFunnelStepOutcome,
} from "@/domains/onboarding/funnel-events";
import { scheduleCheckin } from "@/domains/onboarding/checkin-scheduler";
import { GOOGLE_CALENDAR_EVENTS_SCOPE } from "@/domains/onboarding/hooks/use-google-calendar-connect";
import { formatCheckinTime } from "@/domains/onboarding/format-checkin-time";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import {
  ResearchOnboardingScreen,
  type ResearchOnboardingValues,
} from "@/domains/onboarding/screens/research-onboarding-screen";
import {
  GiveMeAFaceScreen,
  type GiveMeAFaceValues,
} from "@/domains/onboarding/screens/give-me-a-face-screen";
import { IntroductionScreen } from "@/domains/onboarding/screens/introduction-screen";
import { PitchStep } from "@/domains/onboarding/screens/intro-pitch-steps";
import { IntegrationStep } from "@/domains/onboarding/screens/integration-step";
import { CreatePersonalityStep } from "@/domains/onboarding/screens/create-personality-step";
import { LetsChatTomorrowStep } from "@/domains/onboarding/screens/lets-chat-tomorrow-step";
import {
  MeetingCreatedStep,
  LookingYouUpStep,
  FinishingUpStep,
  ResearchResultsStep,
  SuggestionsStep,
  LetsChatReadyStep,
} from "@/domains/onboarding/screens/research-result-steps";
import { OnboardingTonedBackdrop } from "@/domains/onboarding/components/onboarding-toned-backdrop";
import {
  OnboardingStageSizeProvider,
  useElementSize,
} from "@/domains/onboarding/hooks/use-onboarding-stage-size";

/** Build the research subject from the collected form values. */
function researchSubjectFrom(values: ResearchOnboardingValues): ResearchSubject {
  return {
    firstName: values.firstName,
    lastName: values.lastName,
    occupation: values.role,
    hobby: values.hobbies.join(", "),
  };
}

/** Friendly title for the behind-the-scenes research conversation. */
function researchTitleFor(values: ResearchOnboardingValues): string {
  const first = values.firstName.trim();
  return first ? `Getting to know ${first}` : "Getting to know you";
}

// Warm the (~48 kB) bundled-avatar chunk the instant this lazy route loads, so
// the edge cast is ready as the form paints instead of popping in a beat later.
preloadBundledAvatarComponents();

export function ResearchOnboardingRoute() {
  const navigate = useNavigate();
  const user = useAuthStore.use.user();
  const userId = user?.id ?? null;
  const enterFocus = useOnboardingFocusStore.use.enterFocus();
  const exitFocus = useOnboardingFocusStore.use.exitFocus();
  const setPendingAvatarTraits =
    useOnboardingFocusStore.use.setPendingAvatarTraits();
  const requestSidebarCollapse =
    useOnboardingFocusStore.use.requestSidebarCollapse();
  // Research/personality onboarding is now THE onboarding — it fully replaces
  // the legacy pre-chat funnel and is no longer flag-gated, so the route always
  // renders and the "Create my personality" step is always shown.
  const personalityEnabled = true;

  // Sub-steps share this route: details form → avatar/name picker →
  // introduction → pitch (the "different" step, which carousels its lines to
  // the payoff) → integration → "let's chat tomorrow". The toned steps share a
  // persistent backdrop so the avatars/eyes stay put. The handoff fires from
  // the "let's chat tomorrow" step (or the picker's skip).
  const [step, setStep] = useState<ResearchStep>("form");
  // Measure the shared toned-step container so the persistent backdrop, eyes,
  // peekers, and coin all position against the same box as the foreground
  // content (see use-onboarding-stage-size).
  const { ref: tonedStageRef, size: tonedStageSize } = useElementSize();
  // Forward-history (redo) stack: pushed when the user steps back, popped when
  // they step forward via the header's forward chevron. The chevron only shows
  // while this is non-empty — i.e. only after a back. A deliberate forward move
  // (any Continue/Skip) clears it, browser-style.
  const [forwardStack, setForwardStack] = useState<ResearchStep[]>([]);
  // Gates the persistence write + mid-flow research re-fire on the one-shot
  // restore pass below, so we never clobber a saved snapshot before reading it
  // (or re-fire research before adopting saved results). Flips true once the
  // restore has run — whether it found a snapshot or not.
  const [restored, setRestored] = useState(false);

  function navTo(next: ResearchStep) {
    setStep(next);
  }
  // Forward (Continue/Skip): a fresh forward move invalidates the redo stack.
  // Every forward move records the step being LEFT, tagged with how it was left
  // (`completed` for Continue, `skipped` for a Skip) so analytics can tell a
  // deliberate completion apart from a skip. Defaults to `completed`; the skip
  // affordances pass `skipped` explicitly. Back/redo moves deliberately don't emit.
  function goForwardTo(
    next: ResearchStep,
    outcome: OnboardingFunnelStepOutcome = "completed",
  ) {
    emitResearchOnboardingStepCompleted(RESEARCH_ONBOARDING_FUNNEL_STEPS[step], {
      userId,
      outcome,
    });
    setForwardStack([]);
    navTo(next);
  }
  // Back: remember where we were so the forward chevron can return there.
  function goBackTo(prev: ResearchStep) {
    setForwardStack((s) => [...s, step]);
    navTo(prev);
  }
  // Redo: pop the most-recently-backed-from step.
  function goForward() {
    const next = forwardStack[forwardStack.length - 1];
    if (!next) return;
    setForwardStack((s) => s.slice(0, -1));
    navTo(next);
  }
  // Passed to the step screens' header; undefined hides the forward chevron.
  const onForward = forwardStack.length > 0 ? goForward : undefined;
  const [formValues, setFormValues] = useState<ResearchOnboardingValues | null>(
    null,
  );
  const [faceValues, setFaceValues] = useState<GiveMeAFaceValues | null>(null);
  // Personality sliders live here (not in the step) so they survive a step-back
  // and stay shown once locked. `personalityLocked` flips true on the first
  // continue — the prompt has been sent, so the sliders can't be edited again.
  const [personalityValues, setPersonalityValues] = useState<
    Record<string, number>
  >({});
  const [personalityLocked, setPersonalityLocked] = useState(false);
  // Id of the behind-the-scenes "research me" conversation. Captured the moment
  // it's minted (and restored from the snapshot on refresh) so a mid-search
  // reload re-attaches to that same thread instead of starting a second search.
  const [researchConversationId, setResearchConversationId] = useState<
    string | null
  >(null);
  // Formatted booked check-in time ("2:30 PM"), set when scheduleCheckin lands;
  // null until then (or if booking failed) → confirmation shows generic copy.
  const [checkinTime, setCheckinTime] = useState<string | null>(null);
  // True while the booking request is in flight, so the confirmation step can
  // hold (capped) until the booked time is known instead of advancing early.
  const [checkinPending, setCheckinPending] = useState(false);
  // True only once the daemon confirms the check-in was booked. Persisted so a
  // refresh that interrupts the in-flight booking POST doesn't resume past the
  // calendar step as if it succeeded (the endpoint is non-idempotent — a blind
  // retry would double-book), and resumes back to the calendar step instead.
  const [checkinBooked, setCheckinBooked] = useState(false);
  // Set when the Google grant landed WITHOUT the calendar.events scope (the user
  // didn't tick the calendar box on Google's granular-consent screen). The
  // connection succeeds but no event can be booked, so we keep the user on the
  // "let's chat tomorrow" step with a recoverable re-prompt instead of advancing
  // to a false confirmation.
  const [missingCalendarScope, setMissingCalendarScope] = useState(false);
  // Bumped by the integration step's coin to jolt the bottom eyes.
  const [eyesBump, setEyesBump] = useState(0);
  // Extra edge characters revealed so far — grows as the looking-you-up
  // carousel advances, then stays for the results/suggestions steps.
  const [edgeAvatars, setEdgeAvatars] = useState(0);

  // Provision the assistant in the background the moment the user lands here,
  // so it's (usually) healthy by the time they finish the intro/pitch steps —
  // and run the "research me" turn against it, surfacing real claims +
  // suggestions for the in-flow result steps. The research turn is gated on the
  // LATER of the details submit (subject) and hatch readiness: `start()` is
  // called on submit and internally awaits the hatch.
  // A local-hosting onboarding (hosting=local/docker) already provisioned its
  // assistant in the hatching screen, so the background hatch ADOPTS it rather
  // than running a managed hatch; when the query string is missing, a live
  // gateway-auth session is the same evidence (see
  // `shouldAdoptExistingAssistant`). Vellum-Cloud onboarding runs the managed
  // hatch.
  const [searchParams] = useSearchParams();
  const hostingParam = searchParams.get("hosting");
  const adoptExistingAssistant = shouldAdoptExistingAssistant({
    hostingParam,
    localMode: isLocalMode(),
    gatewayAuthSession: isGatewayAuthMode(),
  });
  // The hatching screen names the assistant it provisioned in the `assistant`
  // param, pinning adoption to that exact one — a stale selection or leftover
  // lockfile entries from previous sessions can't answer for it.
  const adoptAssistantId = searchParams.get("assistant") ?? undefined;
  // The day-2 check-in offer ("letschat" → "meeting") books through the
  // platform's managed Google Calendar OAuth. A local-hosting onboarding can
  // run with no platform session at all (the assistant itself is fully
  // local), where that connect can only fail — skip the calendar steps
  // entirely and go straight to the research reveal. Vellum-cloud onboarding
  // keeps them: a managed hatch implies a platform session.
  const skipCheckinSteps = adoptExistingAssistant;
  const {
    start: startHatch,
    ready: hatchReady,
    assistantId: hatchedAssistantId,
    error: hatchError,
    awaitReady: awaitHatchReady,
  } = useBackgroundHatch({
    adoptExisting: adoptExistingAssistant,
    adoptAssistantId,
  });
  const research = useResearchRunner();
  // Stable across renders (useCallback in the runner); safe as effect deps.
  const { start: startResearch, hydrate: hydrateResearch } = research;
  // In-flight removal correction (if any), fired from the results step. The
  // chat handoff awaits it (alongside the plugin installs) so a removed claim is
  // persisted into the research conversation BEFORE the first real chat is
  // minted — otherwise the rejected facts could still be pulled into its context.
  // Resolves immediately when nothing was corrected (never rejects).
  const researchCorrectionRef = useRef<Promise<void>>(Promise.resolve());
  // In-flight personality rewrite (if any), fired from the personality step. The
  // chat handoff awaits it (alongside the plugin installs + removal correction)
  // so the assistant's persona is fully rewritten BEFORE the first real chat is
  // minted — otherwise the greeting could land in the old, unshaped voice.
  // Resolves immediately when personality was never applied (never rejects).
  const personalityAppliedRef = useRef<Promise<void>>(Promise.resolve());
  // Mirrors the ref as render state so the looking-you-up loading stage can hold
  // its "ready" reveal until the personality rewrite settles too — the carousel
  // keeps cycling while this is true, same as an unsettled research turn.
  const [personalityPending, setPersonalityPending] = useState(false);
  const researchLoading =
    research.status === "idle" || research.status === "running";
  // The research turn settled with nothing to show — skip the "this is what I
  // found" step (it would only say "I didn't turn up much") and go straight to
  // the suggestions.
  const noClaims = !researchLoading && research.claims.length === 0;

  // Landing on the form means a fresh run — clear any stale focus state left
  // behind by an abandoned previous attempt so the form itself never renders
  // chrome-less — and kick off the background hatch (idempotent). This is now
  // the default onboarding, so the hatch fires unconditionally on mount.
  useEffect(() => {
    exitFocus();
    setPendingAvatarTraits(null);
    startHatch();
  }, [exitFocus, setPendingAvatarTraits, startHatch]);

  // Resume a journey saved by a previous session (a page refresh). Runs once,
  // as soon as the user id is known, BEFORE the persistence write / research
  // re-fire effects below (which gate on `restored`). useLayoutEffect so we
  // never paint the form for a journey that should resume deeper in. Restores
  // the collected details + any completed research output and jumps to the
  // right step (the suggestions once research finished — see resolveResumeStep).
  useLayoutEffect(() => {
    if (restored) return;
    // Wait for auth to resolve the user so the snapshot key is correct; the
    // effect re-runs when `userId` lands.
    if (!userId) return;
    const snapshot = readResearchSnapshot(userId);
    // Only resume a journey that got past the form; anything else is a fresh
    // start (the form collects the details the rest of the flow needs).
    if (snapshot?.formValues) {
      setFormValues(snapshot.formValues);
      setFaceValues(snapshot.faceValues);
      setCheckinTime(snapshot.checkinTime);
      setCheckinBooked(snapshot.checkinBooked);
      setResearchConversationId(snapshot.researchConversationId ?? null);
      // Re-enqueue the named plugin installs against the re-hatched assistant so
      // a suggestion click awaits real (idempotent) installs, not an empty map.
      if (snapshot.research)
        hydrateResearch(
          {
            ...snapshot.research,
            pluginCatalog: snapshot.research.pluginCatalog ?? {},
          },
          awaitHatchReady,
        );
      // A snapshot written before the calendar steps were dropped from the
      // local flow (or by a signed-in web session) may resume onto them —
      // remap to the research reveal the skip lands on.
      const resumeStep = resolveResumeStep(snapshot);
      setStep(
        skipCheckinSteps && (resumeStep === "letschat" || resumeStep === "meeting")
          ? "looking"
          : resumeStep,
      );
      setForwardStack([]);
    }
    setRestored(true);
  }, [restored, userId, hydrateResearch, awaitHatchReady, skipCheckinSteps]);

  // Persist the journey as it advances so a refresh can resume it. Gated on
  // `restored` so we don't overwrite the snapshot before reading it, and only
  // once the form is submitted (nothing meaningful to save before then). The
  // research output is saved only once it settles "done" — a half-finished turn
  // is re-fired on resume rather than restored.
  useEffect(() => {
    if (!restored || !formValues) return;
    writeResearchSnapshot(userId, {
      step,
      formValues,
      faceValues,
      checkinTime,
      checkinBooked,
      research:
        research.status === "done"
          ? {
              status: "done",
              claims: research.claims,
              suggestions: research.suggestions,
              installedPlugins: research.installedPlugins,
              pluginCatalog: research.pluginCatalog,
            }
          : null,
      ...(researchConversationId
        ? { researchConversationId }
        : {}),
    });
  }, [
    restored,
    userId,
    step,
    formValues,
    faceValues,
    checkinTime,
    checkinBooked,
    researchConversationId,
    research.status,
    research.claims,
    research.suggestions,
    research.installedPlugins,
    research.pluginCatalog,
  ]);

  // Mid-flow resume: we restored a journey whose research turn hadn't settled.
  // Resume it once from the restored subject. When the prior session got far
  // enough to mint the research conversation, re-attach to that SAME thread
  // (`resumeConversationId`) — the turn keeps generating server-side across the
  // reload, so we poll it instead of running a second search; only if it's gone
  // (or was never minted) does the runner fall back to a fresh run. Only fires
  // when results are absent (status "idle") — a fresh visit has no `formValues`
  // until the form is submitted (which fires the search itself), and a completed
  // resume hydrates the status to "done". The meeting is never re-booked here:
  // that only fires from the calendar step, which a resume skips past.
  useEffect(() => {
    if (!restored) return;
    if (!formValues || research.status !== "idle") return;
    startResearch({
      awaitAssistantId: awaitHatchReady,
      subject: researchSubjectFrom(formValues),
      conversationTitle: researchTitleFor(formValues),
      ...(researchConversationId
        ? { resumeConversationId: researchConversationId }
        : {}),
      onConversationCreated: setResearchConversationId,
      includeSuggestions: !personalityEnabled,
    });
  }, [
    restored,
    formValues,
    researchConversationId,
    research.status,
    startResearch,
    awaitHatchReady,
    personalityEnabled,
  ]);

  // If we're sitting on the results step when the research turn resolves empty
  // (it was still streaming when we arrived), skip ahead to the suggestions.
  useEffect(() => {
    if (step === "results" && noClaims) {
      setForwardStack([]);
      setStep("suggestions");
    }
  }, [step, noClaims]);

  // Build the pre-chat context and hand off to the chat pipeline. The chosen
  // name is applied via `assistantName`; the avatar traits are applied to the
  // assistant after hatch (see the avatar-apply effect). The talk style has no
  // backend field yet, so it's captured but not sent.
  function enterAssistant(
    values: ResearchOnboardingValues,
    face: GiveMeAFaceValues | null,
    entryPrompt?: string,
    { skip = false, hidden = false }: { skip?: boolean; hidden?: boolean } = {},
  ) {
    // Handing off to the chat ends the research-onboarding journey — drop the
    // resume snapshot so a later visit starts clean instead of resuming this one.
    clearResearchSnapshot(userId);

    const { firstName, lastName, role, hobbies } = values;
    const fullName = [firstName.trim(), lastName.trim()]
      .filter(Boolean)
      .join(" ");
    const trimmedFirstName = firstName.trim();
    // The research kickoff path is the only one that auto-sends a research
    // prompt and renders focused; suggestions send their prompt as a normal
    // chat, and "Skip to Chat" sends nothing at all.
    const isResearch = !skip && entryPrompt === undefined;

    const context: PreChatOnboardingContext = {
      // Required handoff fields — no tool/task/tone collection in this flow.
      tools: [],
      tasks: [],
      tone: DEFAULT_GROUP_ID,
      ...(fullName ? { userName: fullName } : {}),
      // `occupation` is the prechat profile's field name for the person's role.
      ...(role.trim() ? { occupation: role.trim() } : {}),
      // First message: the picked suggestion if entering from one, otherwise the
      // research kickoff prompt. Omitted on "Skip to Chat" so the user lands in a
      // blank chat ready to type.
      ...(skip
        ? {}
        : {
            initialMessage:
              entryPrompt ??
              buildResearchPrompt({
                firstName,
                lastName,
                occupation: role,
                hobby: hobbies.join(", "),
              }),
            // A hidden kickoff (the "Let's chat" handoff) drives the first reply
            // without rendering a user bubble, so the chat opens as a proactive
            // greeting in the configured persona.
            ...(hidden ? { initialMessageHidden: true } : {}),
          }),
      // Friendly title for the behind-the-scenes research conversation.
      ...(isResearch
        ? {
            title: trimmedFirstName
              ? `Getting to know ${trimmedFirstName}`
              : "Getting to know you",
          }
        : {}),
      // Apply the avatar name chosen on the picker (if any).
      ...(face?.name?.trim() ? { assistantName: face.name.trim() } : {}),
    };

    setPendingPreChatContext(context);
    const assistantName = face?.name?.trim();
    if (assistantName) setPendingAssistantName(assistantName);

    // Stage the chosen avatar traits; OnboardingAvatarApplier applies them once
    // the assistant is hatched (they're not part of the pre-chat context).
    setPendingAvatarTraits(face?.traits ?? null);

    // The research pass renders in the focused presentation; entering from a
    // suggestion (or skipping) is a normal chat, so only focus for research.
    if (isResearch) enterFocus();
    // No auto-sent first message when skipping, so don't arm the expectation.
    if (!skip) lifecycleService.markExpectingFirstMessage();
    // Collapse the side panel so the workspace opens focused on the new chat.
    requestSidebarCollapse();
    // Pin the refresh to the background-hatched assistant so the handoff targets
    // it (not a previously-selected one) and doesn't trigger a second hatch.
    void lifecycleService
      .checkAssistant(hatchedAssistantId ?? undefined)
      .finally(() => {
        void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
      });
  }

  // Final personality-onboarding handoff: wait out any background capability
  // installs (so the primed chat can discover their skills), any removal
  // correction (so rejected claims can't leak in), and the personality rewrite
  // (so the greeting lands in the configured persona), then drop into a fresh
  // chat with the hidden kickoff. `personalityAppliedRef` usually resolves
  // instantly here — the "finishing" step already held for it — but the await is
  // kept as a backstop. Best-effort; none of these reject.
  async function finishAndEnterChat() {
    // Only ever called from the terminal steps, which render under a
    // `formValues`-narrowed guard — but that narrowing doesn't reach this
    // top-level definition, so re-check for the type (and as a safety net).
    if (!formValues) return;
    await Promise.all([
      research.awaitPluginInstalls(),
      researchCorrectionRef.current,
      personalityAppliedRef.current,
    ]);
    enterAssistant(
      formValues,
      faceValues,
      buildLetsChatKickoffMessage(faceValues?.name),
      { hidden: true },
    );
  }

  function handleFormSubmit(values: ResearchOnboardingValues) {
    setFormValues(values);
    // Fire the research turn now; the runner awaits hatch readiness internally,
    // so it starts at the later of this submit and the background hatch.
    research.start({
      awaitAssistantId: awaitHatchReady,
      subject: researchSubjectFrom(values),
      conversationTitle: researchTitleFor(values),
      onConversationCreated: setResearchConversationId,
      // The "Let's chat" final step replaces suggestions when personality
      // onboarding is on, so don't ask the model to generate any.
      includeSuggestions: !personalityEnabled,
    });
    goForwardTo("face");
  }

  // Day-2 check-in: once the Google Calendar grant lands, fire the check-in
  // prompt into its own conversation (best-effort, never blocks) and advance to
  // the "Meeting Created!" confirmation.
  //
  // The grant can "connect" without the calendar.events scope when the user
  // skips the calendar checkbox on Google's granular-consent screen. That's a
  // recoverable user error — not a transient daemon failure — so hold on this
  // step with a re-prompt rather than booking nothing and showing a false
  // confirmation.
  //
  // Only block on a POSITIVE denial: a populated scope list that lacks
  // calendar.events (a real denial still carries the identity scopes, so it's
  // never empty). An empty list is ambiguous — the connection row may not have
  // synced yet, the fetch may have failed, or a legacy connection may omit
  // scope data — so treat it as unknown and fall through to the best-effort
  // schedule. This mirrors the daemon resolver, which rejects only when a
  // connection positively lacks a required scope and never on unknown data.
  function handleCheckinConnected(scopes: string[]) {
    const calendarDenied =
      scopes.length > 0 && !scopes.includes(GOOGLE_CALENDAR_EVENTS_SCOPE);
    if (calendarDenied) {
      setMissingCalendarScope(true);
      return;
    }
    setMissingCalendarScope(false);
    if (hatchedAssistantId && formValues) {
      const fullName = [formValues.firstName.trim(), formValues.lastName.trim()]
        .filter(Boolean)
        .join(" ");
      setCheckinTime(null);
      setCheckinBooked(false);
      setCheckinPending(true);
      void scheduleCheckin({
        assistantId: hatchedAssistantId,
        userName: fullName || undefined,
        assistantName: faceValues?.name?.trim() || undefined,
      })
        .then((result) => {
          if (result.scheduled) {
            setCheckinBooked(true);
            setCheckinTime(formatCheckinTime(result.start, result.timeZone));
          }
        })
        .finally(() => setCheckinPending(false));
    }
    goForwardTo("meeting");
  }

  // The later steps share one persistent toned backdrop (assistant color +
  // eyes + tone characters) so the avatars stay put while the foreground
  // content swaps. Extra edge characters pop in per step to build excitement.
  const tonedSteps = [
    "different",
    "personality",
    "integration",
    "letschat",
    "meeting",
    "looking",
    "results",
    "suggestions",
    "finishing",
  ];
  if (tonedSteps.includes(step) && formValues) {
    // After the calendar, the background blends to black and the giant bottom
    // eyes collapse into the small avatar beside the text. Extra edge
    // characters are revealed by the looking-you-up carousel (see edgeAvatars).
    const postCalendar = ["meeting", "looking", "results", "suggestions", "finishing"].includes(step);
    // The edge crowd is gone from the pitch/setup steps — there it's just the
    // top team and the eyes. The crowd builds up one character per message
    // during the looking-you-up carousel, then stays on for the result steps and
    // the finishing hand-off.
    const peekLevel = ["looking", "results", "suggestions", "finishing"].includes(step)
      ? edgeAvatars
      : 0;
    return (
      <div ref={tonedStageRef} data-theme="dark" className="relative h-full overflow-hidden">
        <OnboardingStageSizeProvider size={tonedStageSize}>
        <OnboardingTonedBackdrop
          eyesBumpNonce={eyesBump}
          peekLevel={peekLevel}
          darkBg={postCalendar}
          // The pitch step ("different") choreographs its own eyes (rising to
          // speak the lines in), so hide the backdrop's resting pair there to
          // avoid doubling. Every other toned step uses the backdrop's resting
          // eyes. The top-right team isn't persistent — the pitch step peeks
          // its own transient team in and out (see PitchStep).
          showBottomEyes={!postCalendar && step !== "different"}
        />
        {step === "different" && (
          <PitchStep
            onContinue={() =>
              goForwardTo(personalityEnabled ? "personality" : "integration")
            }
            onBack={() => goBackTo("intro")}
            onForward={onForward}
          />
        )}
        {step === "personality" && (
          <CreatePersonalityStep
            values={personalityValues}
            onValueChange={(axisId, value) =>
              setPersonalityValues((prev) => ({ ...prev, [axisId]: value }))
            }
            locked={personalityLocked}
            onContinue={() => {
              // First continue applies the sliders to the assistant's persona on
              // a throwaway side thread (awaits hatch readiness internally, then
              // archives) and locks them — the prompt has been sent, so a later
              // step-back can't silently diverge. The rewrite turn runs during
              // the later steps; we track its promise (and pending flag) so the
              // looking-you-up loader holds until it settles and the chat handoff
              // awaits it, guaranteeing the persona is reshaped before the first
              // real chat. Best-effort; it never rejects. A continue while
              // already locked just advances.
              if (!personalityLocked) {
                setPersonalityPending(true);
                personalityAppliedRef.current = applyPersonality({
                  awaitAssistantId: awaitHatchReady,
                  values: personalityValues,
                  userName: formValues?.firstName?.trim() || undefined,
                  assistantName: faceValues?.name?.trim() || undefined,
                }).finally(() => setPersonalityPending(false));
                setPersonalityLocked(true);
              }
              goForwardTo("integration");
            }}
            onBack={() => goBackTo("different")}
            onForward={onForward}
          />
        )}
        {step === "integration" && (
          <IntegrationStep
            onClaim={() => goForwardTo(skipCheckinSteps ? "looking" : "letschat")}
            onBumpEyes={() => setEyesBump((n) => n + 1)}
            onBack={() =>
              goBackTo(personalityEnabled ? "personality" : "different")
            }
            onForward={onForward}
          />
        )}
        {step === "letschat" && (
          <LetsChatTomorrowStep
            assistantId={hatchedAssistantId}
            assistantReady={hatchReady}
            hatchError={hatchError}
            onConnected={handleCheckinConnected}
            missingCalendarScope={missingCalendarScope}
            onRetry={() => setMissingCalendarScope(false)}
            onSkip={() => {
              setMissingCalendarScope(false);
              goForwardTo("looking", "skipped");
            }}
            onBack={() => goBackTo("integration")}
            onForward={onForward}
          />
        )}
        {step === "meeting" && (
          <MeetingCreatedStep
            scheduledTime={checkinTime ?? undefined}
            awaitingTime={checkinPending}
            onDone={() => goForwardTo("looking")}
            onBack={() => goBackTo("letschat")}
            onForward={onForward}
          />
        )}
        {step === "looking" && (
          <LookingYouUpStep
            onDone={() => goForwardTo(noClaims ? "suggestions" : "results")}
            onBack={() => goBackTo(skipCheckinSteps ? "integration" : "letschat")}
            onAdvance={(i) => setEdgeAvatars(Math.min(i + 1, 4))}
            onForward={onForward}
            // Gate only on the web-search turn — the personality rewrite runs
            // decoupled in the background and is finished off in its own step
            // right before the chat handoff (see the "finishing" step), so this
            // quick loading state isn't held hostage to the persona turn.
            ready={!researchLoading}
          />
        )}
        {step === "results" && (
          <ResearchResultsStep
            claims={research.claims}
            loading={researchLoading}
            onContinue={(removed) => {
              // Pruned claims are wrong — tell the assistant to disregard them so
              // they don't leak into the real chat (the research turn taught its
              // memory these facts). The chat handoff awaits this promise, so the
              // correction is persisted before the first conversation is minted.
              if (researchConversationId && hatchedAssistantId && removed.length > 0) {
                researchCorrectionRef.current = sendResearchCorrection({
                  assistantId: hatchedAssistantId,
                  conversationId: researchConversationId,
                  removedClaims: removed,
                  rejectedAll: false,
                });
              }
              goForwardTo("suggestions");
            }}
            onRejectAll={() => {
              // "This is not me" — the search matched someone else. Disown the
              // whole result so none of it carries into the assistant's context.
              if (researchConversationId && hatchedAssistantId) {
                researchCorrectionRef.current = sendResearchCorrection({
                  assistantId: hatchedAssistantId,
                  conversationId: researchConversationId,
                  removedClaims: research.claims.map((c) => c.claim),
                  rejectedAll: true,
                });
              }
              goForwardTo("suggestions", "skipped");
            }}
            onBack={() => goBackTo("looking")}
            onForward={onForward}
          />
        )}
        {step === "suggestions" && personalityEnabled && (
          <LetsChatReadyStep
            installedPlugins={research.installedPlugins}
            pluginCatalog={research.pluginCatalog}
            onStart={async () => {
              // Terminal step: the handoff leaves via enterAssistant, not
              // goForwardTo, so emit the completion here (mirrors SuggestionsStep).
              emitResearchOnboardingStepCompleted(
                RESEARCH_ONBOARDING_FUNNEL_STEPS.suggestions,
                { userId, outcome: "completed" },
              );
              // If the personality rewrite is still running, show the dedicated
              // "finishing" carousel that holds until it settles, then enters
              // chat — so the persona is fully written first without the invisible
              // "Starting…" button stalling on a long turn. If it's already done,
              // drop straight into chat.
              if (personalityPending) {
                setForwardStack([]);
                setStep("finishing");
                return;
              }
              await finishAndEnterChat();
            }}
            onBack={() => goBackTo(noClaims ? "looking" : "results")}
            onForward={onForward}
          />
        )}
        {step === "suggestions" && !personalityEnabled && (
          <SuggestionsStep
            suggestions={research.suggestions}
            loading={researchLoading}
            installedPlugins={research.installedPlugins}
            onSuggestionClick={async (suggestion) => {
              // Terminal step: the handoff leaves via enterAssistant, not
              // goForwardTo, so emit the suggestions completion here (mirrors the
              // pre-chat funnel emitting on its final step before completeFlow).
              emitResearchOnboardingStepCompleted(
                RESEARCH_ONBOARDING_FUNNEL_STEPS.suggestions,
                { userId, outcome: "completed" },
              );
              // Wait out any background capability installs so the new chat can
              // discover their skills (else it silently degrades to a generic
              // prompt). Usually instant — installs kicked off while the user
              // reviewed the results. Also wait for any removal correction to
              // persist so rejected claims can't leak into this first chat.
              await Promise.all([
                research.awaitPluginInstalls(),
                researchCorrectionRef.current,
              ]);
              enterAssistant(formValues, faceValues, suggestion.prompt);
            }}
            onSkip={async () => {
              // "Skip to Chat" — record the suggestions step as skipped.
              emitResearchOnboardingStepCompleted(
                RESEARCH_ONBOARDING_FUNNEL_STEPS.suggestions,
                { userId, outcome: "skipped" },
              );
              await Promise.all([
                research.awaitPluginInstalls(),
                researchCorrectionRef.current,
              ]);
              enterAssistant(formValues, faceValues, undefined, { skip: true });
            }}
            onBack={() => goBackTo(noClaims ? "looking" : "results")}
            onForward={onForward}
          />
        )}
        {step === "finishing" && (
          <FinishingUpStep
            // Hold the carousel until the personality rewrite settles, then hand
            // off. `finishAndEnterChat` also awaits the (usually already-resolved)
            // plugin installs + correction before dropping into chat.
            ready={!personalityPending}
            onDone={() => void finishAndEnterChat()}
          />
        )}
        </OnboardingStageSizeProvider>
      </div>
    );
  }

  if (step === "intro" && formValues) {
    return (
      <IntroductionScreen
        firstName={formValues.firstName}
        assistantName={faceValues?.name}
        onContinue={() => goForwardTo("different")}
        onBack={() => goBackTo("face")}
        onForward={onForward}
      />
    );
  }

  if (step === "face" && formValues) {
    return (
      <GiveMeAFaceScreen
        onContinue={(face) => {
          setFaceValues(face);
          goForwardTo("intro");
        }}
        onBack={() => goBackTo("form")}
        onForward={onForward}
      />
    );
  }

  return (
    <ResearchOnboardingScreen
      initialFirstName={user?.firstName ?? ""}
      initialLastName={user?.lastName ?? ""}
      onSubmit={handleFormSubmit}
    />
  );
}
