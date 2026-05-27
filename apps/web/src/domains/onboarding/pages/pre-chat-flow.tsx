import * as Sentry from "@sentry/browser";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useIsIOSWeb, useIsMacOSWeb } from "@/utils/platform-detection";
import { readIOSAppDownloaded } from "@/hooks/use-ios-app-nudge";
import { readMacOsAppDownloaded } from "@/hooks/use-macos-app-nudge";
import { persistContentAutomationPreChatHandoff } from "@/domains/onboarding/content-automation";
import { GetIOSAppScreen } from "@/domains/onboarding/screens/get-ios-app-screen";
import { GetMacOSAppScreen } from "@/domains/onboarding/screens/get-macos-app-screen";
import { GoogleConnectScreen } from "@/domains/onboarding/screens/google-connect-screen";
import { NameExchangeScreen } from "@/domains/onboarding/screens/name-exchange-screen";
import { PriorAssistantSelectionScreen } from "@/domains/onboarding/screens/prior-assistant-selection-screen";
import { NameStepScreen } from "@/domains/onboarding/screens/name-step-screen";
import { TaskToneSelectionScreen } from "@/domains/onboarding/screens/task-tone-selection-screen";
import { ToolSelectionScreen } from "@/domains/onboarding/screens/tool-selection-screen";
import { VibeStepScreen } from "@/domains/onboarding/screens/vibe-step-screen";
import { assistantsActiveRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { usePrefilledInput } from "@/hooks/use-prefilled-input";
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
} from "@/domains/onboarding/signals";
import { resolveUserCohort } from "@/domains/onboarding/utm-cohort";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

/**
 * Screen indices for the PreChat flow:
 *   0 = NameExchange
 *   1 = TaskTone
 *   2 = ToolSelection
 *   3 = PriorAssistants
 *   4 = GoogleOAuth
 *   5 = GetApp (conditional — shown only on iOS/macOS web)
 */
type Screen = 0 | 1 | 2 | 3 | 4 | 5;

const IOS_TOTAL_STEPS = 3;

export function PreChatFlow() {
  const navigate = useNavigate();
  const user = useAuthStore.use.user();
  const isLoggedIn = useAuthStore.use.isLoggedIn();
  const isAuthLoading = useAuthStore.use.isLoading();
  const userId = user?.id ?? null;
  const firstName = user?.firstName ?? "";
  const lastName = user?.lastName ?? "";
  const isNative = useIsNativePlatform();
  const [, setOnboardingCompleted] = useOnboardingCompleted();
  const [cohort, setCohort] = useState<string | null>(null);

  const isMacOSWeb = useIsMacOSWeb();
  const isIOSWeb = useIsIOSWeb();
  const showAppStep =
    (isIOSWeb && !readIOSAppDownloaded()) ||
    (isMacOSWeb && !readMacOsAppDownloaded());

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

  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedPriorAssistants, setSelectedPriorAssistants] = useState<Set<string>>(
    () => new Set(),
  );
  const { value: userName, onChange: handleUserNameChange } =
    usePrefilledInput(firstName || lastName);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [displayedAssistantNames] = useState<string[]>(
    () => sampleSuggestionNames(),
  );
  const [assistantName, setAssistantName] = useState<string>("");
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleScopes, setGoogleScopes] = useState<string[]>([]);

  const { data: activeAssistant } = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled: !isAuthLoading && isLoggedIn,
  });

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
    if (isAuthLoading || !isLoggedIn) return;
    let cancelled = false;
    void resolveUserCohort().then((resolved) => {
      if (!cancelled && resolved) setCohort(resolved);
    });
    return () => { cancelled = true; };
  }, [isAuthLoading, isLoggedIn]);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!isLoggedIn) {
      void navigate(routes.account.login, { replace: true });
      return;
    }
    if (readOnboardingCompleted()) {
      void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
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
    navigate,
    setOnboardingCompleted,
    userId,
  ]);

  // ── Content-automation cohort: skip all pre-chat screens (web only) ──
  const autoSkippedRef = useRef(false);
  useEffect(() => {
    if (cohort !== "content-automation" || isNative) return;
    if (isAuthLoading || !isLoggedIn || consentDecision !== "ok") return;
    if (readOnboardingCompleted()) return;
    if (autoSkippedRef.current) return;
    autoSkippedRef.current = true;

    persistContentAutomationPreChatHandoff();
    try {
      setOnboardingCompleted(true);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { context: "prechat_auto_skip_content_automation" },
      });
    }
    clearPrivacyConsent();
    void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
  }, [cohort, isNative, isAuthLoading, isLoggedIn, consentDecision, navigate, setOnboardingCompleted]);

  function finish(connectedScopes?: string[]): void {
    const context: PreChatOnboardingContext = {
      tools: stripOtherPrefix([...selectedTools]),
      tasks: [...selectedTasks].sort(),
      tone: selectedGroupId ?? DEFAULT_GROUP_ID,
    };
    const trimmedUser = userName.trim();
    if (trimmedUser) context.userName = trimmedUser;
    const trimmedAssistant = assistantName.trim();
    if (trimmedAssistant) context.assistantName = trimmedAssistant;
    if (connectedScopes) {
      context.googleConnected = true;
      context.googleScopes = connectedScopes;
    } else if (googleConnected) {
      context.googleConnected = true;
      context.googleScopes = googleScopes;
    } else {
      context.googleConnected = false;
    }
    if (selectedPriorAssistants.size > 0) {
      context.priorAssistants = stripOtherPrefix([...selectedPriorAssistants]);
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
    void navigate(`${routes.assistant}?onboarding=1`, { replace: true });
  }

  const consentReady = isNative || consentDecision === "ok";
  if (
    isAuthLoading ||
    !isLoggedIn ||
    !consentReady ||
    readOnboardingCompleted()
  ) {
    return null;
  }

  if (cohort === "content-automation" && !isNative) {
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

  // ── Web flow: NameExchange → TaskTone → Tools → PriorAssistants → Google → App ──

  if (screen === 0) {
    return (
      <NameExchangeScreen
        userName={userName}
        assistantName={assistantName}
        selectedGroupId={selectedGroupId}
        displayedAssistantNames={displayedAssistantNames}
        onUserNameChange={handleUserNameChange}
        onAssistantNameChange={setAssistantName}
        onGroupChange={setSelectedGroupId}
        onComplete={() => setScreen(1)}
        onSkip={() => setScreen(1)}
      />
    );
  }

  if (screen === 1) {
    return (
      <TaskToneSelectionScreen
        selectedTasks={selectedTasks}
        onChange={setSelectedTasks}
        onBack={() => setScreen(0)}
        onContinue={() => setScreen(2)}
        onSkip={() => setScreen(2)}
      />
    );
  }

  const hasGoogleTool = [...selectedTools].some((id) => GOOGLE_TOOL_IDS.has(id));

  const advancePastToolSelection = () => {
    setScreen(3);
  };

  const advancePastPriorAssistants = () => {
    if (hasGoogleTool) {
      setScreen(4);
    } else if (showAppStep) {
      setScreen(5);
    } else {
      finish();
    }
  };

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
        onContinue={advancePastPriorAssistants}
        onSkip={() => {
          setSelectedPriorAssistants(new Set());
          advancePastPriorAssistants();
        }}
      />
    );
  }

  if (screen === 4) {
    if (!activeAssistant) {
      return null;
    }
    return (
      <GoogleConnectScreen
        assistantId={activeAssistant.id}
        assistantName={assistantName}
        selectedGoogleToolIds={[...selectedTools].filter((id) => GOOGLE_TOOL_IDS.has(id))}
        onConnect={(scopes) => {
          setGoogleConnected(true);
          setGoogleScopes(scopes);
          if (showAppStep) {
            setScreen(5);
          } else {
            finish(scopes);
          }
        }}
        onSkip={showAppStep ? () => setScreen(5) : () => finish()}
        onBack={() => setScreen(3)}
      />
    );
  }

  if (screen === 5) {
    if (isIOSWeb) return <GetIOSAppScreen onComplete={() => finish()} />;
    return <GetMacOSAppScreen onComplete={() => finish()} />;
  }

  return null;
}
