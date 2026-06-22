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
import { HowShouldITalkScreen } from "@/domains/onboarding/screens/how-should-i-talk-screen";
import { IntegrationStep } from "@/domains/onboarding/screens/integration-step";
import { LetsChatTomorrowStep } from "@/domains/onboarding/screens/lets-chat-tomorrow-step";
import {
  MeetingCreatedStep,
  LookingYouUpStep,
  ResearchResultsStep,
  SuggestionsStep,
} from "@/domains/onboarding/screens/research-result-steps";
import {
  OnboardingTonedBackdrop,
  type TalkStyle,
} from "@/domains/onboarding/components/onboarding-toned-backdrop";

export function ResearchOnboardingRoute() {
  const navigate = useNavigate();
  const user = useAuthStore.use.user();
  const enterFocus = useOnboardingFocusStore.use.enterFocus();
  const exitFocus = useOnboardingFocusStore.use.exitFocus();
  const setPendingAvatarTraits =
    useOnboardingFocusStore.use.setPendingAvatarTraits();
  // Belt-and-suspenders gate: the spike lives at a dedicated path AND behind
  // this flag (off by default; enable locally via the feature-flags panel).
  const enabled = useClientFeatureFlagStore.use.researchOnboarding();
  const flagsHydrated = useClientFeatureFlagStore.use.hydrated();

  // Sub-steps share this route: details form → avatar/name picker →
  // introduction → talk-style → integration → "let's chat tomorrow". The last
  // three share a persistent toned backdrop so the avatars/eyes stay put. The
  // handoff fires from the "let's chat tomorrow" step (or the picker's skip).
  const [step, setStep] = useState<
    | "form"
    | "face"
    | "intro"
    | "talk"
    | "integration"
    | "letschat"
    | "meeting"
    | "looking"
    | "results"
    | "suggestions"
  >("form");
  const [formValues, setFormValues] = useState<ResearchOnboardingValues | null>(
    null,
  );
  const [faceValues, setFaceValues] = useState<GiveMeAFaceValues | null>(null);
  const [talkStyle, setTalkStyle] = useState<TalkStyle | null>(null);
  // Bumped by the integration step's coin to jolt the bottom eyes.
  const [eyesBump, setEyesBump] = useState(0);
  // Extra edge characters revealed so far — grows as the looking-you-up
  // carousel advances, then stays for the results/suggestions steps.
  const [edgeAvatars, setEdgeAvatars] = useState(0);

  // Landing on the form means a fresh run — clear any stale focus state left
  // behind by an abandoned previous attempt so the form itself never renders
  // chrome-less.
  useEffect(() => {
    exitFocus();
  }, [exitFocus]);

  // Build the pre-chat context and hand off to the chat pipeline. The chosen
  // name is applied via `assistantName`; the avatar traits are applied to the
  // assistant after hatch (see the avatar-apply effect). The talk style has no
  // backend field yet, so it's captured but not sent.
  function enterAssistant(
    values: ResearchOnboardingValues,
    face: GiveMeAFaceValues | null,
    entryPrompt?: string,
  ) {
    const { firstName, lastName, role, hobbies } = values;
    const fullName = [firstName.trim(), lastName.trim()]
      .filter(Boolean)
      .join(" ");
    const trimmedFirstName = firstName.trim();

    const context: PreChatOnboardingContext = {
      // Required handoff fields — no tool/task/tone collection in this flow.
      tools: [],
      tasks: [],
      tone: DEFAULT_GROUP_ID,
      ...(fullName ? { userName: fullName } : {}),
      // `occupation` is the prechat profile's field name for the person's role.
      ...(role.trim() ? { occupation: role.trim() } : {}),
      // First message: the picked suggestion if we're entering from one,
      // otherwise the research kickoff prompt.
      initialMessage:
        entryPrompt ??
        buildResearchPrompt({
          firstName,
          lastName,
          occupation: role,
          hobby: hobbies.join(", "),
        }),
      // Friendly title for the behind-the-scenes research conversation.
      ...(entryPrompt
        ? {}
        : {
            title: trimmedFirstName
              ? `Getting to know ${trimmedFirstName}`
              : "Getting to know you",
          }),
      // Apply the avatar name chosen on the picker (if any).
      ...(face?.name?.trim() ? { assistantName: face.name.trim() } : {}),
    };

    setPendingPreChatContext(context);

    // Stage the chosen avatar traits; OnboardingAvatarApplier applies them once
    // the assistant is hatched (they're not part of the pre-chat context).
    setPendingAvatarTraits(face?.traits ?? null);

    // The research pass renders in the focused presentation; entering directly
    // from a suggestion is a normal chat, so only focus for the research path.
    if (!entryPrompt) enterFocus();
    lifecycleService.markExpectingFirstMessage();
    void lifecycleService.checkAssistant().finally(() => {
      void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
    });
  }

  function handleFormSubmit(values: ResearchOnboardingValues) {
    setFormValues(values);
    setStep("face");
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
    "talk",
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
    return (
      <div data-theme="dark" className="relative h-full overflow-hidden">
        <OnboardingTonedBackdrop
          talkStyle={talkStyle}
          eyesBumpNonce={eyesBump}
          extraPeekLevel={edgeAvatars}
          darkBg={postCalendar}
          showBottomEyes={!postCalendar}
        />
        {step === "talk" && (
          <HowShouldITalkScreen
            selected={talkStyle}
            onSelect={setTalkStyle}
            onContinue={() => setStep("integration")}
            onSkip={() => setStep("integration")}
            onBack={() => setStep("intro")}
          />
        )}
        {step === "integration" && (
          <IntegrationStep
            onClaim={() => setStep("letschat")}
            onBumpEyes={() => setEyesBump((n) => n + 1)}
            onBack={() => setStep("talk")}
          />
        )}
        {step === "letschat" && (
          <LetsChatTomorrowStep
            onConnect={() => setStep("meeting")}
            onSkip={() => setStep("looking")}
            onBack={() => setStep("integration")}
          />
        )}
        {step === "meeting" && (
          <MeetingCreatedStep
            onDone={() => setStep("looking")}
            onBack={() => setStep("letschat")}
          />
        )}
        {step === "looking" && (
          <LookingYouUpStep
            onDone={() => setStep("results")}
            onBack={() => setStep("letschat")}
            onAdvance={(i) => setEdgeAvatars(Math.min(i + 1, 4))}
          />
        )}
        {step === "results" && (
          <ResearchResultsStep
            firstName={formValues.firstName}
            role={formValues.role}
            onContinue={() => setStep("suggestions")}
            onBack={() => setStep("looking")}
          />
        )}
        {step === "suggestions" && (
          <SuggestionsStep
            onSuggestionClick={(prompt) =>
              enterAssistant(formValues, faceValues, prompt)
            }
            onBack={() => setStep("results")}
          />
        )}
      </div>
    );
  }

  if (step === "intro" && formValues) {
    return (
      <IntroductionScreen
        firstName={formValues.firstName}
        onContinue={() => setStep("talk")}
        onBack={() => setStep("face")}
      />
    );
  }

  if (step === "face" && formValues) {
    return (
      <GiveMeAFaceScreen
        onContinue={(face) => {
          setFaceValues(face);
          setStep("intro");
        }}
        onBack={() => setStep("form")}
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
