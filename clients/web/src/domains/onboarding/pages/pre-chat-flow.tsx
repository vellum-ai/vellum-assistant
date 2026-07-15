import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useIsIOSWeb } from "@/runtime/platform-detection";
import { readIOSAppDownloaded } from "@/hooks/use-ios-app-nudge";
import { fetchOnboardingRecipe } from "@/domains/onboarding/recipe-client.js";
import {
  emitOnboardingFunnelStepCompleted,
  ONBOARDING_FUNNEL_STEPS,
} from "@/domains/onboarding/funnel-events";
import { GetIOSAppScreen } from "@/domains/onboarding/screens/get-ios-app-screen.js";
import { GoogleConnectScreen } from "@/domains/onboarding/screens/google-connect-screen.js";
import { NameExchangeScreen } from "@/domains/onboarding/screens/name-exchange-screen.js";
import { NameStepScreen } from "@/domains/onboarding/screens/name-step-screen.js";
import { PriorAssistantSelectionScreen } from "@/domains/onboarding/screens/prior-assistant-selection-screen.js";
import { TaskToneSelectionScreen } from "@/domains/onboarding/screens/task-tone-selection-screen.js";
import { ToolSelectionScreen } from "@/domains/onboarding/screens/tool-selection-screen.js";
import { VibeStepScreen } from "@/domains/onboarding/screens/vibe-step-screen.js";
import { assistantsActiveRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import { usePrefilledInput } from "@/hooks/use-prefilled-input.js";
import {
  setPendingAssistantName,
  setPendingPreChatContext,
} from "@/domains/onboarding/prechat";
import { buildPreChatContext } from "@/domains/onboarding/prechat-context";
import {
  isPlatformFunnelAvailable,
  nextStep,
  prevStep,
  resolveNativeSteps,
  resolveWebSteps,
  type PreChatStep,
} from "@/domains/onboarding/prechat-steps";
import {
  DEFAULT_GROUP_ID,
  sampleSuggestionNames,
} from "@/domains/onboarding/prechat-names";
import { GOOGLE_TOOL_IDS } from "@/domains/onboarding/prechat-tools";
import { usePreChatConsentGate } from "@/domains/onboarding/use-prechat-consent-gate";
import { usePreChatStepState } from "@/domains/onboarding/use-prechat-step-state";
import {
  getPlatformAssistants,
  getSelectedAssistant,
  isLocalMode,
} from "@/lib/local-mode";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useIsNativePlatform } from "@/runtime/native-auth.js";
import {
  useAuthStore,
  useIsAuthenticated,
  useIsSessionInitializing,
} from "@/stores/auth-store.js";
import { hasLivePlatformSession } from "@/stores/session-status";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes.js";

const IOS_TOTAL_STEPS = 3;

function readLocalPlatformAssistantId(): string | null {
  const selected = getSelectedAssistant();
  if (selected?.cloud === "vellum") {
    return selected.assistantId;
  }
  return getPlatformAssistants()[0]?.assistantId ?? null;
}

export function PreChatFlow() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get("preview") === "true";
  const user = useAuthStore.use.user();
  const isAuthenticated = useIsAuthenticated();
  const isAuthInitializing = useIsSessionInitializing();
  const userId = user?.id ?? null;
  const firstName = user?.firstName ?? "";
  const lastName = user?.lastName ?? "";
  const isNative = useIsNativePlatform();
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const localMode = isLocalMode();
  const isIOSWeb = useIsIOSWeb();
  const showIOSAppStep = isIOSWeb && !readIOSAppDownloaded();
  const activationFlowArm =
    useClientFeatureFlagStore.use.stringFlags()
      .experimentActivationFlow20260603 ?? "control";
  const activationFlowEnabled = activationFlowArm === "variant-a";
  const selfIntroGreetingEnabled =
    useClientFeatureFlagStore.use.selfIntroGreeting();
  const localPlatformAssistantId = localMode
    ? readLocalPlatformAssistantId()
    : null;

  const consentReady = usePreChatConsentGate();
  const { currentStep, setCurrentStep, clearPersistedStep } =
    usePreChatStepState(userId, isNative);

  const platformSession = useAuthStore.use.platformSession();
  const hasPlatformSession = hasLivePlatformSession(platformSession);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedPriorAssistants, setSelectedPriorAssistants] = useState<
    Set<string>
  >(() => new Set());
  const { value: userName, onChange: handleUserNameChange } = usePrefilledInput(
    localMode && !hasPlatformSession ? "" : firstName || lastName,
  );
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [displayedAssistantNames] = useState<string[]>(() =>
    sampleSuggestionNames(),
  );
  const [assistantName, setAssistantName] = useState<string>("");
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleScopes, setGoogleScopes] = useState<string[]>([]);

  const { data: activeAssistant } = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled:
      !isAuthInitializing &&
      isAuthenticated &&
      (!localMode || hasPlatformSession),
  });
  const { data: fetchedRecipe, isLoading: recipeLoading } = useQuery({
    queryKey: ["onboarding-recipe", userId],
    queryFn: fetchOnboardingRecipe,
    enabled: !isAuthInitializing && isAuthenticated && !isNative && !localMode,
    staleTime: Infinity,
  });
  const recipe = fetchedRecipe ?? null;
  const googleAssistantId =
    activeAssistant?.id ?? activeAssistantId ?? localPlatformAssistantId;
  const platformFunnelAvailable = isPlatformFunnelAvailable({
    localMode,
    platformSession,
    hasCachedPlatformAssistant: localPlatformAssistantId !== null,
  });
  const canOfferGoogleStep = platformFunnelAvailable;
  const canOfferPriorAssistants = platformFunnelAvailable;

  const navigateToChatAfterLifecycleRefresh = async () => {
    await lifecycleService.checkAssistant();
    void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
  };

  function emitWebFunnelStep(
    step: (typeof ONBOARDING_FUNNEL_STEPS)[keyof typeof ONBOARDING_FUNNEL_STEPS],
  ): void {
    if (isPreview) {
      return;
    }
    emitOnboardingFunnelStepCompleted(step, { userId });
  }

  const hasGoogleTool = [...selectedTools].some((id) =>
    GOOGLE_TOOL_IDS.has(id),
  );

  const steps: PreChatStep[] = isNative
    ? resolveNativeSteps()
    : resolveWebSteps({
        canOfferPriorAssistants,
        canOfferGoogleStep: isPreview ? false : canOfferGoogleStep,
        hasGoogleTool,
        showIOSAppStep,
      });

  function completeFlow(args?: {
    connectedScopes?: string[];
    selectedPriorAssistants?: Set<string>;
  }): void {
    if (isPreview) {
      navigate(-1);
      return;
    }

    const context = buildPreChatContext({
      mode: isNative ? "native" : "control",
      recipe: isNative ? null : recipe,
      selectedTools,
      selectedTasks,
      selectedPriorAssistants:
        args?.selectedPriorAssistants ?? selectedPriorAssistants,
      tone: selectedGroupId ?? recipe?.tone ?? DEFAULT_GROUP_ID,
      userName,
      assistantName,
      selfIntroGreetingEnabled,
      activationFlowEnabled: isNative ? undefined : activationFlowEnabled,
      googleConnected,
      googleScopes,
      connectedScopes: args?.connectedScopes,
    });

    setPendingPreChatContext(context);
    const trimmedAssistant = assistantName.trim();
    if (trimmedAssistant) setPendingAssistantName(trimmedAssistant);

    if (isNative) {
      clearPersistedStep();
      void navigate(routes.onboarding.privacy);
    } else {
      lifecycleService.markExpectingFirstMessage();
      void navigateToChatAfterLifecycleRefresh();
    }
  }

  const advance = (
    from: PreChatStep,
    finishArgs?: {
      connectedScopes?: string[];
      selectedPriorAssistants?: Set<string>;
    },
  ): void => {
    if (from.funnelStep) emitWebFunnelStep(from.funnelStep);
    const next = nextStep(steps, from.id);
    if (next) {
      setCurrentStep(next);
    } else {
      completeFlow(finishArgs);
    }
  };

  const goBack = (from: PreChatStep): void => {
    const previous = prevStep(steps, from.id);
    if (previous) setCurrentStep(previous);
  };

  if (!consentReady || recipeLoading) {
    return null;
  }

  const activeStep = steps.find((step) => step.id === currentStep) ?? steps[0];
  if (!activeStep) {
    return null;
  }

  if (activeStep.id === "nativeName") {
    return (
      <NameStepScreen
        userName={userName}
        assistantName={assistantName}
        displayedAssistantNames={displayedAssistantNames}
        onUserNameChange={handleUserNameChange}
        onAssistantNameChange={setAssistantName}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
        currentStep={0}
        totalSteps={IOS_TOTAL_STEPS}
      />
    );
  }

  if (activeStep.id === "nativeVibe") {
    return (
      <VibeStepScreen
        selectedGroupId={selectedGroupId}
        onGroupChange={setSelectedGroupId}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
        currentStep={1}
        totalSteps={IOS_TOTAL_STEPS}
      />
    );
  }

  if (activeStep.id === "name") {
    return (
      <NameExchangeScreen
        userName={userName}
        assistantName={assistantName}
        selectedGroupId={selectedGroupId}
        displayedAssistantNames={displayedAssistantNames}
        onUserNameChange={handleUserNameChange}
        onAssistantNameChange={setAssistantName}
        onGroupChange={setSelectedGroupId}
        onComplete={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
      />
    );
  }

  if (activeStep.id === "taskTone") {
    return (
      <TaskToneSelectionScreen
        selectedTasks={selectedTasks}
        onChange={setSelectedTasks}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
      />
    );
  }

  if (activeStep.id === "tools") {
    return (
      <ToolSelectionScreen
        selectedTools={selectedTools}
        onChange={setSelectedTools}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
      />
    );
  }

  if (activeStep.id === "priorAssistants") {
    return (
      <PriorAssistantSelectionScreen
        selectedAssistants={selectedPriorAssistants}
        onChange={setSelectedPriorAssistants}
        onBack={() => goBack(activeStep)}
        onContinue={() => advance(activeStep)}
        onSkip={() => {
          const emptyPriorAssistants = new Set<string>();
          setSelectedPriorAssistants(emptyPriorAssistants);
          advance(activeStep, {
            selectedPriorAssistants: emptyPriorAssistants,
          });
        }}
      />
    );
  }

  if (activeStep.id === "google") {
    if (!googleAssistantId) {
      return null;
    }
    return (
      <GoogleConnectScreen
        assistantId={googleAssistantId}
        assistantName={assistantName}
        onConnect={(scopes) => {
          setGoogleConnected(true);
          setGoogleScopes(scopes);
          advance(activeStep, { connectedScopes: scopes });
        }}
        onSkip={() => advance(activeStep)}
        onBack={() => goBack(activeStep)}
      />
    );
  }

  if (activeStep.id === "iosApp") {
    return <GetIOSAppScreen onComplete={() => advance(activeStep)} />;
  }

  return null;
}
