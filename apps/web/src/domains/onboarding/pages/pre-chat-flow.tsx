import { captureError } from "@/lib/sentry/capture-error";
import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useIsIOSWeb } from "@/runtime/platform-detection";
import { readIOSAppDownloaded } from "@/hooks/use-ios-app-nudge";
import {
  fetchOnboardingRecipe,
  type OnboardingRecipe,
} from "@/domains/onboarding/recipe-client.js";
import {
  emitOnboardingFunnelStepCompleted,
  onboardingFunnelVariantFromCondensedFlag,
  ONBOARDING_FUNNEL_STEPS,
  ONBOARDING_FUNNEL_VARIANTS,
  readOnboardingFunnelVariant,
  resolveOnboardingFunnelVariant,
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
  nextStep,
  prevStep,
  resolveNativeSteps,
  resolveWebSteps,
  type PreChatStep,
  type PreChatStepId,
} from "@/domains/onboarding/prechat-steps";
import {
  DEFAULT_GROUP_ID,
  sampleSuggestionNames,
} from "@/domains/onboarding/prechat-names";
import { GOOGLE_TOOL_IDS } from "@/domains/onboarding/prechat-tools";
import {
  readOnboardingCompleted,
  readTosAccepted,
  useOnboardingCompleted,
} from "@/domains/onboarding/prefs";
import {
  clearPrivacyConsent,
  hasRecentPrivacyConsent,
} from "@/domains/onboarding/signals.js";
import {
  getPlatformAssistants,
  getSelectedAssistant,
  isLocalMode,
} from "@/lib/local-mode";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useIsNativePlatform } from "@/runtime/native-auth.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
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
  const user = useAuthStore.use.user();
  const isLoggedIn = useAuthStore.use.isLoggedIn();
  const isAuthLoading = useAuthStore.use.isLoading();
  const userId = user?.id ?? null;
  const firstName = user?.firstName ?? "";
  const lastName = user?.lastName ?? "";
  const isNative = useIsNativePlatform();
  const activeAssistantId =
    useAssistantSelectionStore.use.activeAssistantId();
  const [, setOnboardingCompleted] = useOnboardingCompleted();
  const [recipe, setRecipe] = useState<OnboardingRecipe | null>(null);
  const [recipeLoadState, setRecipeLoadState] = useState<"loading" | "ready">(
    "loading",
  );

  const localMode = isLocalMode();
  const isReplay = searchParams.get("replay") === "1";
  const isIOSWeb = useIsIOSWeb();
  const showIOSAppStep = isIOSWeb && !readIOSAppDownloaded();
  const condensedPrechatFlag =
    useClientFeatureFlagStore.use.prechatOnboardingCondensedFlow();
  const selfIntroGreetingEnabled =
    useClientFeatureFlagStore.use.selfIntroGreeting();
  const preferredFunnelVariant =
    onboardingFunnelVariantFromCondensedFlag(condensedPrechatFlag);
  const webFunnelVariant =
    readOnboardingFunnelVariant() ?? preferredFunnelVariant;
  const paredDownPrechat =
    webFunnelVariant === ONBOARDING_FUNNEL_VARIANTS.paredDown;
  const localPlatformAssistantId = localMode
    ? readLocalPlatformAssistantId()
    : null;

  // Native pre-chat restores its position across reloads via sessionStorage
  // — without this, an iOS user who's tapped through to the vibe step and
  // hot-reloads (or returns after the OS reclaims memory) is silently
  // dropped back to the name step. The key is user-scoped so a stale value
  // from user A doesn't bleed into user B if they log in next in the same
  // webview session — `useLayoutEffect` restores before paint once `userId`
  // is known, so the user never sees an incorrect step momentarily.
  const screenStorageKey = userId ? `prechat_native_screen:${userId}` : null;
  const [currentStep, setCurrentStep] = useState<PreChatStepId>(() =>
    isNative ? "nativeName" : "name",
  );
  const persistNativeStep = useCallback(
    (value: PreChatStepId | null) => {
      if (!screenStorageKey) return;
      try {
        if (value === null) {
          sessionStorage.removeItem(screenStorageKey);
        } else {
          sessionStorage.setItem(screenStorageKey, value);
        }
      } catch {
        // sessionStorage can throw under privacy modes — ignore.
      }
    },
    [screenStorageKey],
  );
  useLayoutEffect(() => {
    if (!screenStorageKey) return;
    try {
      const saved = sessionStorage.getItem(screenStorageKey);
      if (saved === "nativeVibe") setCurrentStep("nativeVibe");
    } catch {
      // sessionStorage can throw under privacy modes — ignore.
    }
    // Restore only when the active user changes (mount, or logout→login).
    // Omitting `currentStep` from deps so we don't re-restore mid-flow.
  }, [screenStorageKey]);

  const hasPlatformSession = useAuthStore.use.hasPlatformSession();
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
  const [displayedAssistantNames] = useState<string[]>(
    () => sampleSuggestionNames(),
  );
  const [assistantName, setAssistantName] = useState<string>("");
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleScopes, setGoogleScopes] = useState<string[]>([]);

  const { data: activeAssistant } = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled:
      !isAuthLoading && isLoggedIn && (!localMode || hasPlatformSession),
  });
  const googleAssistantId =
    activeAssistant?.id ?? activeAssistantId ?? localPlatformAssistantId;
  const canOfferGoogleStep =
    !localMode || hasPlatformSession || localPlatformAssistantId !== null;
  // Prior-assistants import belongs to the platform-backed onboarding funnel.
  // In pure local mode there is no platform account behind onboarding, so the
  // step falls out; when a platform session exists (managed mode, including
  // Electron) the full funnel runs. Local mode is gated by capability here
  // rather than special-cased downstream.
  const canOfferPriorAssistants = !localMode || hasPlatformSession;

  const navigateToChatAfterLifecycleRefresh = useCallback(async () => {
    await lifecycleService.checkAssistant();
    void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
  }, [navigate]);

  type ConsentSnapshot = {
    userId: string | null;
    decision: "pending" | "ok" | "missing";
  };
  const [consent, setConsent] = useState<ConsentSnapshot>(() => {
    if (isAuthLoading || !isLoggedIn) {
      return { userId, decision: "pending" };
    }
    return {
      userId,
      decision:
        readTosAccepted() || hasRecentPrivacyConsent(userId) ? "ok" : "missing",
    };
  });
  const consentDecision = consent.decision;
  useEffect(() => {
    if (isAuthLoading || !isLoggedIn) return;
    if (consent.userId === userId && consent.decision !== "pending") return;
    setConsent({
      userId,
      decision:
        readTosAccepted() || hasRecentPrivacyConsent(userId) ? "ok" : "missing",
    });
  }, [consent, isAuthLoading, isLoggedIn, userId]);

  useEffect(() => {
    if (isAuthLoading || !isLoggedIn) {
      setRecipe(null);
      setRecipeLoadState("loading");
      return;
    }
    // The onboarding recipe is platform-only marketing-funnel data, resolved
    // on the platform from a UTM campaign cookie / stored attribution. Local
    // and native runtimes have no marketing cohort, so a null recipe is the
    // correct, complete behavior — there is no recipe endpoint to fetch here.
    if (isNative || localMode) {
      setRecipe(null);
      setRecipeLoadState("ready");
      return;
    }
    let cancelled = false;
    setRecipe(null);
    setRecipeLoadState("loading");
    void fetchOnboardingRecipe()
      .then((fetched) => {
        if (!cancelled) setRecipe(fetched);
      })
      .catch(() => {
        if (!cancelled) setRecipe(null);
      })
      .finally(() => {
        if (!cancelled) setRecipeLoadState("ready");
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthLoading, isLoggedIn, isNative, localMode, userId]);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!isLoggedIn) {
      void navigate(routes.account.login, { replace: true });
      return;
    }
    if (readOnboardingCompleted() && !isReplay) {
      void navigateToChatAfterLifecycleRefresh();
      return;
    }
    if (consentDecision === "missing" && !isNative) {
      void navigate(routes.onboarding.privacy, { replace: true });
      return;
    }
    if (consentDecision === "pending") return;
  }, [
    consentDecision,
    isAuthLoading,
    isLoggedIn,
    isNative,
    isReplay,
    navigate,
    navigateToChatAfterLifecycleRefresh,
    setOnboardingCompleted,
    userId,
  ]);

  const consentReady = isNative || consentDecision === "ok";
  const recipeReady = isNative || recipeLoadState === "ready";
  const shouldHidePrechat =
    isAuthLoading ||
    !isLoggedIn ||
    !consentReady ||
    !recipeReady ||
    (readOnboardingCompleted() && !isReplay);

  function emitWebFunnelStep(
    step: (typeof ONBOARDING_FUNNEL_STEPS)[keyof typeof ONBOARDING_FUNNEL_STEPS],
    variant = webFunnelVariant,
  ): void {
    if (isReplay) return;
    emitOnboardingFunnelStepCompleted(step, {
      userId,
      variant: resolveOnboardingFunnelVariant(variant),
    });
  }

  const hasGoogleTool = [...selectedTools].some((id) =>
    GOOGLE_TOOL_IDS.has(id),
  );

  // The reachable steps are a pure function of capabilities. Local mode, the
  // funnel variant, the connected tool, and platform all "fall out" of these
  // predicates rather than being special-cased in the navigation handlers.
  const steps: PreChatStep[] = isNative
    ? resolveNativeSteps()
    : resolveWebSteps({
        paredDown: paredDownPrechat,
        canOfferPriorAssistants,
        canOfferGoogleStep,
        hasGoogleTool,
        showIOSAppStep,
      });

  async function finish(args?: {
    connectedScopes?: string[];
    selectedPriorAssistants?: Set<string>;
  }): Promise<void> {
    const context = buildPreChatContext({
      mode: paredDownPrechat ? "paredDown" : "control",
      recipe,
      selectedTools,
      selectedTasks,
      selectedPriorAssistants:
        args?.selectedPriorAssistants ?? selectedPriorAssistants,
      tone: selectedGroupId ?? recipe?.tone ?? DEFAULT_GROUP_ID,
      userName,
      assistantName,
      selfIntroGreetingEnabled,
      googleConnected,
      googleScopes,
      connectedScopes: args?.connectedScopes,
    });

    setPendingPreChatContext(context);
    const trimmedAssistant = assistantName.trim();
    if (trimmedAssistant) setPendingAssistantName(trimmedAssistant);
    try {
      setOnboardingCompleted(true);
    } catch (err) {
      captureError(err, { context: "prechat_mark_onboarding_completed" });
    }
    clearPrivacyConsent();
    // User finished pre-chat; the post-hatch greeting is forthcoming.
    // Mark before navigating so the destination chat mount shows the
    // loading gate until the greeting arrives.
    lifecycleService.markExpectingFirstMessage();
    await navigateToChatAfterLifecycleRefresh();
  }

  function finishNativePreChat(): void {
    const context = buildPreChatContext({
      mode: "native",
      recipe: null,
      selectedTools,
      selectedTasks,
      selectedPriorAssistants,
      tone: selectedGroupId ?? DEFAULT_GROUP_ID,
      userName,
      assistantName,
      selfIntroGreetingEnabled,
      googleConnected: false,
      googleScopes: [],
    });
    setPendingPreChatContext(context);
    const trimmedAssistant = assistantName.trim();
    if (trimmedAssistant) setPendingAssistantName(trimmedAssistant);
    persistNativeStep(null);
    void navigate(routes.onboarding.privacy);
  }

  // Advance past `from`: emit its funnel event, then move to the next enabled
  // step — or finish when `from` is the last one. `finishArgs` only matters
  // when this advance ends the flow.
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
      void finish(finishArgs);
    }
  };

  // Back always lands on the previous enabled step, so it can never reveal a
  // step the forward path gated off.
  const goBack = (from: PreChatStepId): void => {
    const previous = prevStep(steps, from);
    if (previous) setCurrentStep(previous);
  };

  if (shouldHidePrechat) {
    return null;
  }

  const activeStep = steps.find((step) => step.id === currentStep);
  if (!activeStep) {
    return null;
  }

  // ── iOS native flow: NameStep → VibeStep → Privacy → Hatching → Chat ──
  if (isNative) {
    if (currentStep === "nativeName") {
      // Continue and Skip both advance to the vibe step and persist the
      // position so the user lands back here after an OS memory reclaim.
      const goToVibeStep = () => {
        setCurrentStep("nativeVibe");
        persistNativeStep("nativeVibe");
      };
      return (
        <NameStepScreen
          userName={userName}
          assistantName={assistantName}
          displayedAssistantNames={displayedAssistantNames}
          onUserNameChange={handleUserNameChange}
          onAssistantNameChange={setAssistantName}
          onContinue={goToVibeStep}
          onSkip={goToVibeStep}
          currentStep={0}
          totalSteps={IOS_TOTAL_STEPS}
        />
      );
    }
    return (
      <VibeStepScreen
        selectedGroupId={selectedGroupId}
        onGroupChange={setSelectedGroupId}
        onBack={() => {
          setCurrentStep("nativeName");
          persistNativeStep(null);
        }}
        onContinue={finishNativePreChat}
        onSkip={finishNativePreChat}
        currentStep={1}
        totalSteps={IOS_TOTAL_STEPS}
      />
    );
  }

  // ── Web flow (control + pared-down funnel variants share one step list) ──
  // Control:    NameExchange → TaskTone → Tools → PriorAssistants → Google → iOS App
  // Pared-down: NameExchange → Google → Chat
  if (currentStep === "name") {
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

  if (currentStep === "taskTone") {
    return (
      <TaskToneSelectionScreen
        selectedTasks={selectedTasks}
        onChange={setSelectedTasks}
        onBack={() => goBack(activeStep.id)}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
      />
    );
  }

  if (currentStep === "tools") {
    return (
      <ToolSelectionScreen
        selectedTools={selectedTools}
        onChange={setSelectedTools}
        onBack={() => goBack(activeStep.id)}
        onContinue={() => advance(activeStep)}
        onSkip={() => advance(activeStep)}
      />
    );
  }

  if (currentStep === "priorAssistants") {
    return (
      <PriorAssistantSelectionScreen
        selectedAssistants={selectedPriorAssistants}
        onChange={setSelectedPriorAssistants}
        onBack={() => goBack(activeStep.id)}
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

  if (currentStep === "google") {
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
        onBack={() => goBack(activeStep.id)}
      />
    );
  }

  if (currentStep === "iosApp") {
    return <GetIOSAppScreen onComplete={() => advance(activeStep)} />;
  }

  return null;
}
