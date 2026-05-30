import * as Sentry from "@sentry/browser";
import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useIsIOSWeb, useIsMacOSWeb } from "@/runtime/platform-detection";
import { readIOSAppDownloaded } from "@/hooks/use-ios-app-nudge";
import { readMacOsAppDownloaded } from "@/hooks/use-macos-app-nudge";
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
import { GetMacOSAppScreen } from "@/domains/onboarding/screens/get-macos-app-screen.js";
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
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";
import {
  DEFAULT_GROUP_ID,
  sampleSuggestionNames,
} from "@/domains/onboarding/prechat-names";
import {
  GOOGLE_TOOL_IDS,
  stripOtherPrefix,
} from "@/domains/onboarding/prechat-tools";
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
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { routes } from "@/utils/routes.js";

/**
 * Screen indices for the PreChat flow:
 *   0 = NameExchange (web) / NameStep (native)
 *   1 = GoogleOAuth (pared-down web) / TaskTone (control web) / VibeStep (native)
 *   2 = ToolSelection (control web)
 *   3 = PriorAssistants (control web)
 *   4 = GoogleOAuth (control web)
 *   5 = GetApp (control web)
 */
type Screen = 0 | 1 | 2 | 3 | 4 | 5;

const IOS_TOTAL_STEPS = 3;
const PARED_DOWN_GOOGLE_TOOL_IDS = [
  "gmail",
  "google-calendar",
  "google-drive",
];

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
  const isMacOSWeb = useIsMacOSWeb();
  const isIOSWeb = useIsIOSWeb();
  const showAppStep =
    (isIOSWeb && !readIOSAppDownloaded()) ||
    (isMacOSWeb && !readMacOsAppDownloaded());
  const condensedPrechatFlag =
    useClientFeatureFlagStore.use.prechatOnboardingCondensedFlow();
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
  const [screen, setScreen] = useState<Screen>(0);
  useLayoutEffect(() => {
    if (!screenStorageKey) return;
    try {
      const saved = sessionStorage.getItem(screenStorageKey);
      if (saved === "1") setScreen(1);
    } catch {
      // sessionStorage can throw under privacy modes — ignore.
    }
    // Restore only when the active user changes (mount, or logout→login).
    // Intentionally omitting `screen` from deps so we don't re-restore mid-flow.
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

  const navigateToChatAfterLifecycleRefresh = useCallback(async () => {
    await useAssistantLifecycleStore.getState().checkAssistant();
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
    // In local mode, the gateway doesn't serve the recipe endpoint. (LUM-2000)
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

  // ── Recipe-driven auto-skip: skip all pre-chat screens (web only) ──
  const autoSkippedRef = useRef(false);
  useEffect(() => {
    if (isReplay) return;
    if (!recipe?.skipPrechat || isNative) return;
    if (isAuthLoading || !isLoggedIn || consentDecision !== "ok") return;
    if (readOnboardingCompleted()) return;
    if (autoSkippedRef.current) return;
    autoSkippedRef.current = true;

    const context: PreChatOnboardingContext = {
      tools: [],
      tasks: recipe.tasks,
      tone: recipe.tone,
      googleConnected: false,
      cohort: recipe.cohort,
      initialMessage: recipe.initialMessage,
      bootstrapTemplate: recipe.bootstrapTemplate,
      skills: recipe.skills,
    };
    setPendingPreChatContext(context);
    try {
      setOnboardingCompleted(true);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { context: "prechat_auto_skip_recipe" },
      });
    }
    clearPrivacyConsent();
    void navigateToChatAfterLifecycleRefresh();
  }, [
    recipe,
    isNative,
    isReplay,
    isAuthLoading,
    isLoggedIn,
    consentDecision,
    navigateToChatAfterLifecycleRefresh,
    setOnboardingCompleted,
  ]);

  const consentReady = isNative || consentDecision === "ok";
  const recipeReady = isNative || recipeLoadState === "ready";
  const shouldHidePrechat =
    isAuthLoading ||
    !isLoggedIn ||
    !consentReady ||
    !recipeReady ||
    (readOnboardingCompleted() && !isReplay) ||
    (recipe?.skipPrechat && !isNative && !isReplay);

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

  async function finish(
    connectedScopes?: string[],
    options: { selectedPriorAssistants?: Set<string> } = {},
  ): Promise<void> {
    const selectedPriorAssistantsForContext =
      options.selectedPriorAssistants ?? selectedPriorAssistants;
    const connectedWithCurrentAction = connectedScopes !== undefined;
    const context: PreChatOnboardingContext = paredDownPrechat
      ? {
          tools: connectedWithCurrentAction
            ? [...PARED_DOWN_GOOGLE_TOOL_IDS]
            : [],
          tasks: [],
          tone: selectedGroupId ?? DEFAULT_GROUP_ID,
          googleConnected: connectedWithCurrentAction,
        }
      : {
          tools: stripOtherPrefix([...selectedTools]),
          tasks: [...selectedTasks].sort(),
          tone: selectedGroupId ?? DEFAULT_GROUP_ID,
        };
    const trimmedUser = userName.trim();
    if (trimmedUser) context.userName = trimmedUser;
    const trimmedAssistant = assistantName.trim();
    if (trimmedAssistant) context.assistantName = trimmedAssistant;

    if (paredDownPrechat) {
      if (connectedWithCurrentAction) {
        context.googleScopes = connectedScopes;
      }
    } else if (connectedWithCurrentAction) {
      context.googleConnected = true;
      context.googleScopes = connectedScopes;
    } else if (googleConnected) {
      context.googleConnected = true;
      context.googleScopes = googleScopes;
    } else {
      context.googleConnected = false;
    }
    if (!paredDownPrechat && selectedPriorAssistantsForContext.size > 0) {
      context.priorAssistants = stripOtherPrefix([
        ...selectedPriorAssistantsForContext,
      ]);
    }
    context.initialMessage = "Wake up, my friend!";

    setPendingPreChatContext(context);
    if (trimmedAssistant) setPendingAssistantName(trimmedAssistant);
    try {
      setOnboardingCompleted(true);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { context: "prechat_mark_onboarding_completed" },
      });
    }
    clearPrivacyConsent();
    await navigateToChatAfterLifecycleRefresh();
  }

  if (shouldHidePrechat) {
    return null;
  }

  // ── iOS native flow: NameStep → VibeStep → Privacy → Hatching → Chat ──
  if (isNative) {
    if (screen === 0) {
      // Both Continue and Skip advance to the vibe step and persist the
      // position so the user lands back here on reload — shared closure
      // keeps the two callsites from drifting.
      const goToVibeStep = () => {
        setScreen(1);
        if (screenStorageKey) {
          try {
            sessionStorage.setItem(screenStorageKey, "1");
          } catch {
            // ignore — see initial-state comment.
          }
        }
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
    const finishNativePreChat = () => {
      const context: PreChatOnboardingContext = {
        tools: [],
        tasks: [],
        tone: selectedGroupId ?? DEFAULT_GROUP_ID,
      };
      const trimmedUser = userName.trim();
      if (trimmedUser) {
        context.userName = trimmedUser;
      }
      const trimmedAssistant = assistantName.trim();
      if (trimmedAssistant) {
        context.assistantName = trimmedAssistant;
      }
      context.googleConnected = false;
      context.initialMessage = "Wake up, my friend!";
      setPendingPreChatContext(context);
      if (trimmedAssistant) {
        setPendingAssistantName(trimmedAssistant);
      }
      if (screenStorageKey) {
        try {
          sessionStorage.removeItem(screenStorageKey);
        } catch {
          // ignore — see initial-state comment.
        }
      }
      void navigate(routes.onboarding.privacy);
    };
    return (
      <VibeStepScreen
        selectedGroupId={selectedGroupId}
        onGroupChange={setSelectedGroupId}
        onBack={() => {
          setScreen(0);
          if (screenStorageKey) {
            try {
              sessionStorage.removeItem(screenStorageKey);
            } catch {
              // ignore — see initial-state comment.
            }
          }
        }}
        onContinue={finishNativePreChat}
        onSkip={finishNativePreChat}
        currentStep={1}
        totalSteps={IOS_TOTAL_STEPS}
      />
    );
  }

  // ── Web flow:
  // Control: NameExchange → TaskTone → Tools → PriorAssistants → Google → App
  // Treatment: NameExchange → Google → Chat

  if (screen === 0) {
    const advance = () => {
      emitWebFunnelStep(ONBOARDING_FUNNEL_STEPS.nameVibe);
      if (paredDownPrechat) {
        if (!canOfferGoogleStep) {
          void finish();
          return;
        }
        setScreen(1);
        return;
      }
      setScreen(1);
    };
    return (
      <NameExchangeScreen
        userName={userName}
        assistantName={assistantName}
        selectedGroupId={selectedGroupId}
        displayedAssistantNames={displayedAssistantNames}
        onUserNameChange={handleUserNameChange}
        onAssistantNameChange={setAssistantName}
        onGroupChange={setSelectedGroupId}
        onComplete={advance}
        onSkip={advance}
      />
    );
  }

  if (paredDownPrechat && screen === 1) {
    if (!googleAssistantId) {
      return null;
    }
    return (
      <GoogleConnectScreen
        assistantId={googleAssistantId}
        assistantName={assistantName}
        onConnect={(scopes) => {
          emitWebFunnelStep(ONBOARDING_FUNNEL_STEPS.gmailConnect);
          void finish(scopes);
        }}
        onSkip={() => {
          emitWebFunnelStep(ONBOARDING_FUNNEL_STEPS.gmailConnect);
          void finish();
        }}
        onBack={() => setScreen(0)}
      />
    );
  }

  const hasGoogleTool = [...selectedTools].some((id) =>
    GOOGLE_TOOL_IDS.has(id),
  );

  const advancePastToolSelection = () => {
    emitWebFunnelStep(ONBOARDING_FUNNEL_STEPS.controlTools);
    if (localMode) {
      void finish();
      return;
    }
    setScreen(3);
  };

  const advancePastPriorAssistants = (
    nextPriorAssistants = selectedPriorAssistants,
  ) => {
    emitWebFunnelStep(ONBOARDING_FUNNEL_STEPS.controlPriorAssistants);
    if (hasGoogleTool && canOfferGoogleStep) {
      setScreen(4);
    } else if (showAppStep) {
      setScreen(5);
    } else {
      void finish(undefined, {
        selectedPriorAssistants: nextPriorAssistants,
      });
    }
  };

  if (screen === 1) {
    const advance = () => {
      emitWebFunnelStep(ONBOARDING_FUNNEL_STEPS.controlWorkType);
      setScreen(2);
    };
    return (
      <TaskToneSelectionScreen
        selectedTasks={selectedTasks}
        onChange={setSelectedTasks}
        onBack={() => setScreen(0)}
        onContinue={advance}
        onSkip={advance}
      />
    );
  }

  if (screen === 2) {
    return (
      <ToolSelectionScreen
        selectedTools={selectedTools}
        onChange={setSelectedTools}
        onBack={() => setScreen(1)}
        onContinue={advancePastToolSelection}
        onSkip={advancePastToolSelection}
      />
    );
  }

  if (screen === 3) {
    return (
      <PriorAssistantSelectionScreen
        selectedAssistants={selectedPriorAssistants}
        onChange={setSelectedPriorAssistants}
        onBack={() => setScreen(2)}
        onContinue={() => advancePastPriorAssistants()}
        onSkip={() => {
          const emptyPriorAssistants = new Set<string>();
          setSelectedPriorAssistants(emptyPriorAssistants);
          advancePastPriorAssistants(emptyPriorAssistants);
        }}
      />
    );
  }

  if (screen === 4) {
    if (!googleAssistantId) {
      return null;
    }
    return (
      <GoogleConnectScreen
        assistantId={googleAssistantId}
        assistantName={assistantName}
        onConnect={(scopes) => {
          emitWebFunnelStep(ONBOARDING_FUNNEL_STEPS.controlGmailConnect);
          setGoogleConnected(true);
          setGoogleScopes(scopes);
          if (showAppStep) {
            setScreen(5);
          } else {
            void finish(scopes);
          }
        }}
        onSkip={() => {
          emitWebFunnelStep(ONBOARDING_FUNNEL_STEPS.controlGmailConnect);
          if (showAppStep) {
            setScreen(5);
          } else {
            void finish();
          }
        }}
        onBack={() => setScreen(3)}
      />
    );
  }

  if (screen === 5) {
    const completeAppStep = () => {
      emitWebFunnelStep(ONBOARDING_FUNNEL_STEPS.controlGetApp);
      void finish();
    };
    if (isIOSWeb) {
      return <GetIOSAppScreen onComplete={completeAppStep} />;
    }
    return <GetMacOSAppScreen onComplete={completeAppStep} />;
  }

  return null;
}
