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

import {
  fetchOnboardingRecipe,
  type OnboardingRecipe,
} from "@/domains/onboarding/recipe-client.js";
import { GoogleConnectScreen } from "@/domains/onboarding/screens/google-connect-screen.js";
import { NameExchangeScreen } from "@/domains/onboarding/screens/name-exchange-screen.js";
import { NameStepScreen } from "@/domains/onboarding/screens/name-step-screen.js";
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
import { useIsNativePlatform } from "@/runtime/native-auth.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { useRootOutletContext } from "@/root-layout";
import { routes } from "@/utils/routes.js";

/**
 * Screen indices for the PreChat flow:
 *   0 = NameExchange (web) / NameStep (native)
 *   1 = GoogleOAuth (web) / VibeStep (native)
 */
type Screen = 0 | 1;

const IOS_TOTAL_STEPS = 3;
const GOOGLE_TOOL_IDS = ["gmail", "google-calendar", "google-drive"];

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
  const { lifecycle } = useRootOutletContext();
  const { assistantId: lifecycleAssistantId, checkAssistant } = lifecycle;
  const [, setOnboardingCompleted] = useOnboardingCompleted();
  const [recipe, setRecipe] = useState<OnboardingRecipe | null>(null);
  const [recipeLoadState, setRecipeLoadState] = useState<"loading" | "ready">(
    "loading",
  );

  const localMode = isLocalMode();
  const isReplay = searchParams.get("replay") === "1";
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
  const { value: userName, onChange: handleUserNameChange } = usePrefilledInput(
    localMode && !hasPlatformSession ? "" : firstName || lastName,
  );
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [displayedAssistantNames] = useState<string[]>(
    () => sampleSuggestionNames(),
  );
  const [assistantName, setAssistantName] = useState<string>("");

  const { data: activeAssistant } = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled:
      !isAuthLoading && isLoggedIn && (!localMode || hasPlatformSession),
  });
  const googleAssistantId =
    activeAssistant?.id ?? lifecycleAssistantId ?? localPlatformAssistantId;
  const canOfferGoogleStep =
    !localMode || hasPlatformSession || localPlatformAssistantId !== null;

  const navigateToChatAfterLifecycleRefresh = useCallback(async () => {
    await checkAssistant();
    void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
  }, [checkAssistant, navigate]);

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

  async function finish(connectedScopes?: string[]): Promise<void> {
    const googleConnected = connectedScopes !== undefined;
    const context: PreChatOnboardingContext = {
      tools: googleConnected ? [...GOOGLE_TOOL_IDS] : [],
      tasks: [],
      tone: selectedGroupId ?? DEFAULT_GROUP_ID,
      googleConnected,
    };
    const trimmedUser = userName.trim();
    if (trimmedUser) context.userName = trimmedUser;
    const trimmedAssistant = assistantName.trim();
    if (trimmedAssistant) context.assistantName = trimmedAssistant;
    if (googleConnected) {
      context.googleScopes = connectedScopes;
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

  const consentReady = isNative || consentDecision === "ok";
  const recipeReady = isNative || recipeLoadState === "ready";
  if (
    isAuthLoading ||
    !isLoggedIn ||
    !consentReady ||
    !recipeReady ||
    (readOnboardingCompleted() && !isReplay)
  ) {
    return null;
  }

  if (recipe?.skipPrechat && !isNative && !isReplay) {
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

  // ── Web flow: NameExchange → Google → Chat ──

  if (screen === 0) {
    const advance = () => {
      if (!canOfferGoogleStep) {
        void finish();
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

  if (screen === 1) {
    if (!googleAssistantId) {
      return null;
    }
    return (
      <GoogleConnectScreen
        assistantId={googleAssistantId}
        assistantName={assistantName}
        onConnect={(scopes) => {
          void finish(scopes);
        }}
        onSkip={() => {
          void finish();
        }}
        onBack={() => setScreen(0)}
      />
    );
  }

  return null;
}
