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

import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";

import { lifecycleService } from "@/assistant/lifecycle-service";
import { useAuthStore } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { routes } from "@/utils/routes";
import { DEFAULT_GROUP_ID } from "@/domains/onboarding/prechat-names";
import {
  setPendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";
import { buildResearchPrompt } from "@/domains/onboarding/research-prompt";
import { useBackgroundHatch } from "@/domains/onboarding/use-background-hatch";
import { useResearchRunner } from "@/domains/onboarding/research-runner";
import { scheduleCheckin } from "@/domains/onboarding/checkin-scheduler";
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
import { LetsChatTomorrowStep } from "@/domains/onboarding/screens/lets-chat-tomorrow-step";
import {
  MeetingCreatedStep,
  LookingYouUpStep,
  ResearchResultsStep,
  SuggestionsStep,
} from "@/domains/onboarding/screens/research-result-steps";
import { OnboardingTonedBackdrop } from "@/domains/onboarding/components/onboarding-toned-backdrop";

type ResearchStep =
  | "form"
  | "face"
  | "intro"
  | "different"
  | "integration"
  | "letschat"
  | "meeting"
  | "looking"
  | "results"
  | "suggestions";

export function ResearchOnboardingRoute() {
  const navigate = useNavigate();
  const user = useAuthStore.use.user();
  const enterFocus = useOnboardingFocusStore.use.enterFocus();
  const exitFocus = useOnboardingFocusStore.use.exitFocus();
  const setPendingAvatarTraits =
    useOnboardingFocusStore.use.setPendingAvatarTraits();
  const requestSidebarCollapse =
    useOnboardingFocusStore.use.requestSidebarCollapse();
  // Belt-and-suspenders gate: the spike lives at a dedicated path AND behind
  // this flag (off by default; enable locally via the feature-flags panel).
  const enabled = useClientFeatureFlagStore.use.researchOnboarding();
  const flagsHydrated = useClientFeatureFlagStore.use.hydrated();

  // Sub-steps share this route: details form → avatar/name picker →
  // introduction → pitch (the "different" step, which carousels its lines to
  // the payoff) → integration → "let's chat tomorrow". The toned steps share a
  // persistent backdrop so the avatars/eyes stay put. The handoff fires from
  // the "let's chat tomorrow" step (or the picker's skip).
  const [step, setStep] = useState<ResearchStep>("form");
  // Forward-history (redo) stack: pushed when the user steps back, popped when
  // they step forward via the header's forward chevron. The chevron only shows
  // while this is non-empty — i.e. only after a back. A deliberate forward move
  // (any Continue/Skip) clears it, browser-style.
  const [forwardStack, setForwardStack] = useState<ResearchStep[]>([]);

  function navTo(next: ResearchStep) {
    setStep(next);
  }
  // Forward (Continue/Skip): a fresh forward move invalidates the redo stack.
  function goForwardTo(next: ResearchStep) {
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
  // Formatted booked check-in time ("2:30 PM"), set when scheduleCheckin lands;
  // null until then (or if booking failed) → confirmation shows generic copy.
  const [checkinTime, setCheckinTime] = useState<string | null>(null);
  // True while the booking request is in flight, so the confirmation step can
  // hold (capped) until the booked time is known instead of advancing early.
  const [checkinPending, setCheckinPending] = useState(false);
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
  const {
    start: startHatch,
    ready: hatchReady,
    assistantId: hatchedAssistantId,
    awaitReady: awaitHatchReady,
  } = useBackgroundHatch();
  const research = useResearchRunner();
  const researchLoading =
    research.status === "idle" || research.status === "running";
  // The research turn settled with nothing to show — skip the "this is what I
  // found" step (it would only say "I didn't turn up much") and go straight to
  // the suggestions.
  const noClaims = !researchLoading && research.claims.length === 0;

  // Landing on the form means a fresh run — clear any stale focus state left
  // behind by an abandoned previous attempt so the form itself never renders
  // chrome-less — and kick off the background hatch (idempotent).
  //
  // Gate the hatch on the flag: a cold visit starts with `researchOnboarding`
  // defaulting to false until LD hydrates, and this effect runs before the
  // `!enabled` redirect below. Without the gate a flag-off visitor would
  // provision + poll an assistant before being bounced away.
  useEffect(() => {
    exitFocus();
    if (enabled && flagsHydrated) startHatch();
  }, [exitFocus, startHatch, enabled, flagsHydrated]);

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
    { skip = false }: { skip?: boolean } = {},
  ) {
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

  function handleFormSubmit(values: ResearchOnboardingValues) {
    setFormValues(values);
    // Fire the research turn now; the runner awaits hatch readiness internally,
    // so it starts at the later of this submit and the background hatch.
    const trimmedFirst = values.firstName.trim();
    research.start({
      awaitAssistantId: awaitHatchReady,
      subject: {
        firstName: values.firstName,
        lastName: values.lastName,
        occupation: values.role,
        hobby: values.hobbies.join(", "),
      },
      conversationTitle: trimmedFirst
        ? `Getting to know ${trimmedFirst}`
        : "Getting to know you",
    });
    goForwardTo("face");
  }

  // Day-2 check-in: once the Google Calendar grant lands, fire the check-in
  // prompt into its own conversation (best-effort, never blocks) and advance to
  // the "Meeting Created!" confirmation.
  function handleCheckinConnected() {
    if (hatchedAssistantId && formValues) {
      const fullName = [formValues.firstName.trim(), formValues.lastName.trim()]
        .filter(Boolean)
        .join(" ");
      setCheckinTime(null);
      setCheckinPending(true);
      void scheduleCheckin({
        assistantId: hatchedAssistantId,
        userName: fullName || undefined,
        assistantName: faceValues?.name?.trim() || undefined,
      })
        .then((result) => {
          if (result.scheduled) {
            setCheckinTime(formatCheckinTime(result.start, result.timeZone));
          }
        })
        .finally(() => setCheckinPending(false));
    }
    goForwardTo("meeting");
  }

  if (!enabled) {
    // A cold load starts with the default-off value while the LD flag is still
    // being fetched; wait for that response before bouncing so a flag that's
    // actually `true` isn't redirected away on first render.
    if (!flagsHydrated) return null;
    return <Navigate to={routes.assistant} replace />;
  }

  // The later steps share one persistent toned backdrop (assistant color +
  // eyes + tone characters) so the avatars stay put while the foreground
  // content swaps. Extra edge characters pop in per step to build excitement.
  const tonedSteps = [
    "different",
    "integration",
    "letschat",
    "meeting",
    "looking",
    "results",
    "suggestions",
  ];
  if (tonedSteps.includes(step) && formValues) {
    // After the calendar, the background blends to black and the giant bottom
    // eyes collapse into the small avatar beside the text. Extra edge
    // characters are revealed by the looking-you-up carousel (see edgeAvatars).
    const postCalendar = ["meeting", "looking", "results", "suggestions"].includes(step);
    // The edge crowd is gone from the pitch/setup steps — there it's just the
    // top team and the eyes. The crowd builds up one character per message
    // during the looking-you-up carousel, then stays on for the result steps.
    const peekLevel = ["looking", "results", "suggestions"].includes(step)
      ? edgeAvatars
      : 0;
    return (
      <div data-theme="dark" className="relative h-full overflow-hidden">
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
            onContinue={() => goForwardTo("integration")}
            onBack={() => goBackTo("intro")}
            onForward={onForward}
          />
        )}
        {step === "integration" && (
          <IntegrationStep
            onClaim={() => goForwardTo("letschat")}
            onBumpEyes={() => setEyesBump((n) => n + 1)}
            onBack={() => goBackTo("different")}
            onForward={onForward}
          />
        )}
        {step === "letschat" && (
          <LetsChatTomorrowStep
            assistantId={hatchedAssistantId}
            assistantReady={hatchReady}
            onConnected={handleCheckinConnected}
            onSkip={() => goForwardTo("looking")}
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
            onBack={() => goBackTo("letschat")}
            onAdvance={(i) => setEdgeAvatars(Math.min(i + 1, 4))}
            onForward={onForward}
          />
        )}
        {step === "results" && (
          <ResearchResultsStep
            claims={research.claims}
            loading={researchLoading}
            onContinue={() => goForwardTo("suggestions")}
            onBack={() => goBackTo("looking")}
            onForward={onForward}
          />
        )}
        {step === "suggestions" && (
          <SuggestionsStep
            suggestions={research.suggestions}
            loading={researchLoading}
            installedPlugins={research.installedPlugins}
            onSuggestionClick={async (suggestion) => {
              // Wait out any background capability installs so the new chat can
              // discover their skills (else it silently degrades to a generic
              // prompt). Usually instant — installs kicked off while the user
              // reviewed the results.
              await research.awaitPluginInstalls();
              enterAssistant(formValues, faceValues, suggestion.prompt);
            }}
            onSkip={async () => {
              await research.awaitPluginInstalls();
              enterAssistant(formValues, faceValues, undefined, { skip: true });
            }}
            onBack={() => goBackTo(noClaims ? "looking" : "results")}
            onForward={onForward}
          />
        )}
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
