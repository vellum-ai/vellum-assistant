import * as Sentry from "@sentry/browser";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { useIsIOSWeb } from "@/domains/nudges/ios-app-platform.js";
import { readIOSAppDownloaded } from "@/domains/nudges/ios-app-prefs.js";
import { useIsMacOSWeb } from "@/domains/nudges/mac-app-platform.js";
import { readMacOsAppDownloaded } from "@/domains/nudges/mac-app-prefs.js";
import { GetIOSAppScreen } from "@/domains/onboarding/screens/get-ios-app-screen.js";
import { GetMacOSAppScreen } from "@/domains/onboarding/screens/get-macos-app-screen.js";
import { GoogleConnectScreen } from "@/domains/onboarding/screens/google-connect-screen.js";
import { NameExchangeScreen } from "@/domains/onboarding/screens/name-exchange-screen.js";
import { NameStepScreen } from "@/domains/onboarding/screens/name-step-screen.js";
import { TaskToneSelectionScreen } from "@/domains/onboarding/screens/task-tone-selection-screen.js";
import { ToolSelectionScreen } from "@/domains/onboarding/screens/tool-selection-screen.js";
import { VibeStepScreen } from "@/domains/onboarding/screens/vibe-step-screen.js";
import { assistantsActiveRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import { usePrefilledInput } from "@/hooks/use-prefilled-input.js";
import {
  setPendingAssistantName,
  setPendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat.js";
import {
  DEFAULT_GROUP_ID,
  sampleSuggestionNames,
} from "@/domains/onboarding/prechat-names.js";
import {
  GOOGLE_TOOL_IDS,
  stripOtherPrefix,
} from "@/domains/onboarding/prechat-tools.js";
import {
  readOnboardingCompleted,
  readTosAccepted,
  useOnboardingCompleted,
} from "@/domains/onboarding/prefs.js";
import {
  clearPrivacyConsent,
  hasRecentPrivacyConsent,
} from "@/domains/onboarding/signals.js";
import { useIsNativePlatform } from "@/runtime/native-auth.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { routes } from "@/utils/routes.js";

/**
 * Screen indices for the PreChat flow:
 *   0 = NameExchange
 *   1 = TaskTone
 *   2 = ToolSelection
 *   3 = GoogleOAuth
 *   4 = GetApp (conditional — shown only on iOS/macOS web)
 */
type Screen = 0 | 1 | 2 | 3 | 4;

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

  const isMacOSWeb = useIsMacOSWeb();
  const isIOSWeb = useIsIOSWeb();
  const showAppStep =
    (isIOSWeb && !readIOSAppDownloaded()) ||
    (isMacOSWeb && !readMacOsAppDownloaded());

  // Native pre-chat restores its position across reloads via sessionStorage
  // — without this, an iOS user who's tapped through to the vibe step and
  // hot-reloads (or returns after the OS reclaims memory) is silently
  // dropped back to the name step.
  const [screen, setScreen] = useState<Screen>(() => {
    try {
      const saved = sessionStorage.getItem("prechat_native_screen");
      if (saved === "1") return 1;
    } catch {
      // sessionStorage can throw under privacy modes — ignore.
    }
    return 0;
  });
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(
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

  // ── iOS native flow: NameStep → VibeStep → Privacy → Hatching → Chat ──
  if (isNative) {
    if (screen === 0) {
      // Both Continue and Skip advance to the vibe step and persist the
      // position so the user lands back here on reload — shared closure
      // keeps the two callsites from drifting.
      const goToVibeStep = () => {
        setScreen(1);
        try {
          sessionStorage.setItem("prechat_native_screen", "1");
        } catch {
          // ignore — see initial-state comment.
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
      setPendingPreChatContext(context);
      if (trimmedAssistant) {
        setPendingAssistantName(trimmedAssistant);
      }
      try {
        sessionStorage.removeItem("prechat_native_screen");
      } catch {
        // ignore — see initial-state comment.
      }
      void navigate(routes.onboarding.privacy);
    };
    return (
      <VibeStepScreen
        selectedGroupId={selectedGroupId}
        onGroupChange={setSelectedGroupId}
        onBack={() => {
          setScreen(0);
          try {
            sessionStorage.removeItem("prechat_native_screen");
          } catch {
            // ignore — see initial-state comment.
          }
        }}
        onContinue={finishNativePreChat}
        onSkip={finishNativePreChat}
        currentStep={1}
        totalSteps={IOS_TOTAL_STEPS}
      />
    );
  }

  // ── Web flow: NameExchange → TaskTone → Tools → Google → App ──

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
    if (hasGoogleTool) {
      setScreen(3);
    } else if (showAppStep) {
      setScreen(4);
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
            setScreen(4);
          } else {
            finish(scopes);
          }
        }}
        onSkip={showAppStep ? () => setScreen(4) : () => finish()}
        onBack={() => setScreen(2)}
      />
    );
  }

  if (screen === 4) {
    if (isIOSWeb) return <GetIOSAppScreen onComplete={() => finish()} />;
    return <GetMacOSAppScreen onComplete={() => finish()} />;
  }

  return null;
}
