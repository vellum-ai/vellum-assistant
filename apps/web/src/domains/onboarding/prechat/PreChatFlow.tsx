
import { useNavigate } from "react-router";
import { useEffect, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import * as Sentry from "@sentry/react";

import { useAuth } from "@/lib/auth.js";
import { usePrefilledInput } from "@/lib/hooks/usePrefilledInput.js";
import { routes } from "@/lib/routes.js";
import {
  readOnboardingCompleted,
  readTosAccepted,
  useOnboardingCompleted,
} from "@/lib/onboarding/prefs.js";
import {
  setPendingAssistantName,
  setPendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/lib/onboarding/prechat.js";
import {
  clearPrivacyConsent,
  hasRecentPrivacyConsent,
} from "@/lib/onboarding/signals.js";
import {
  DEFAULT_GROUP_ID,
  sampleSuggestionNames,
} from "@/lib/onboarding/prechat-names.js";
import {
  GOOGLE_TOOL_IDS,
  stripOtherPrefix,
} from "@/lib/onboarding/prechat-tools.js";

import { useIsIOSWeb } from "@/lib/ios-app-nudge/platform.js";
import { readIOSAppDownloaded } from "@/lib/ios-app-nudge/prefs.js";
import { useIsMacOSWeb } from "@/lib/mac-app-nudge/platform.js";
import { readMacOsAppDownloaded } from "@/lib/mac-app-nudge/prefs.js";

import { assistantsActiveRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";

import { GetIOSAppScreen } from "@/domains/onboarding/prechat/GetIOSAppScreen.js";
import { GetMacOSAppScreen } from "@/domains/onboarding/prechat/GetMacOSAppScreen.js";
import { GoogleConnectScreen } from "@/domains/onboarding/prechat/google-connect-screen.js";
import { NameExchangeScreen } from "@/domains/onboarding/prechat/NameExchangeScreen.js";
import { TaskToneSelectionScreen } from "@/domains/onboarding/prechat/TaskToneSelectionScreen.js";
import { ToolSelectionScreen } from "@/domains/onboarding/prechat/ToolSelectionScreen.js";

/**
 * Screen indices for the PreChat flow:
 *   0 = NameExchange
 *   1 = TaskTone
 *   2 = ToolSelection
 *   3 = GoogleOAuth
 *   4 = GetApp (conditional — shown only on iOS/macOS web)
 */
type Screen = 0 | 1 | 2 | 3 | 4;

/**
 * PreChat onboarding orchestrator. Composes the three macOS-parity
 * screens (tools → tasks/tone → names), shepherds the selections, and
 * stashes the resulting `PreChatOnboardingContext` in sessionStorage on
 * finish. AssistantPageClient drains it on its `?onboarding=1` mount,
 * attaching the payload to the auto-greet send so the daemon can
 * personalize its opener — same wire contract as macOS.
 *
 * Gate order matches `HatchingScreen.decideHatchGate`:
 *   1. auth still loading → wait
 *   2. not logged in → /account/login
 *   3. onboarding already completed → /assistant
 */
export function PreChatFlow() {
  const navigate = useNavigate();
  const {
    userId,
    isLoggedIn,
    isLoading: isAuthLoading,
    firstName,
    lastName,
  } = useAuth();
  // First tuple slot isn't rendered — we only flip the flag on finish to
  // mark the end of the full onboarding flow (HatchingScreen defers
  // this write to us so its own gate doesn't bounce the user past
  // PreChat).
  const [, setOnboardingCompleted] = useOnboardingCompleted();

  const isMacOSWeb = useIsMacOSWeb();
  const isIOSWeb = useIsIOSWeb();
  const showAppStep =
    (isIOSWeb && !readIOSAppDownloaded()) ||
    (isMacOSWeb && !readMacOsAppDownloaded());

  const [screen, setScreen] = useState<Screen>(0);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(
    () => new Set(),
  );
  // Seed the "Your name" input from the authenticated profile so users
  // who signed in with Apple, Google, or any provider that returned a
  // name claim don't have to re-type a name Authentication Services
  // already gave us (Apple App Store Guideline 4). The hook handles
  // the lazy seed, the after-mount backfill if auth resolves late,
  // and never clobbering a value the user has typed or cleared.
  const { value: userName, onChange: handleUserNameChange } =
    usePrefilledInput(firstName || lastName);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [displayedAssistantNames] = useState<string[]>(
    () => sampleSuggestionNames(),
  );
  const [assistantName, setAssistantName] = useState<string>("");
  const [googleConnected, setGoogleConnected] = useState(false);
  const [googleScopes, setGoogleScopes] = useState<string[]>([]);

  // Query the active assistant ID so we can pass it to GoogleConnectScreen.
  // Gated on auth being loaded — we only need this once the user is past
  // the gate, and the active assistant exists after hatching.
  const { data: activeAssistant } = useQuery({
    ...assistantsActiveRetrieveOptions(),
    enabled: !isAuthLoading && isLoggedIn,
  });

  // Snapshot the consent decision once per (mount, userId) pair via a
  // useState lazy initializer. Re-reading `hasRecentPrivacyConsent` on
  // every render would let the in-memory marker's 30s TTL flip a
  // gate-passed user back into a missing-consent state mid-flow.
  //
  // The snapshot is keyed by the userId it was computed for so that a
  // cross-tab session swap (or any other useAuth() identity change
  // mid-mount) re-derives consent for the new user — otherwise user B
  // would inherit user A's "ok" decision and skip TOS entirely.
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
    // Re-derive when userId changes, OR when still pending after auth
    // first resolves. Same-user, already-decided runs are a no-op so
    // `set-state-in-effect` won't cascade.
    if (consent.userId === userId && consent.decision !== "pending") return;
    setConsent({
      userId,
      decision:
        readTosAccepted() || hasRecentPrivacyConsent(userId) ? "ok" : "missing",
    });
  }, [consent, isAuthLoading, isLoggedIn, userId]);

  // Gate effect — short-circuits via redirect/return when the flow
  // shouldn't proceed. Runs on mount and whenever any input flips.
  useEffect(() => {
    if (isAuthLoading) return;
    if (!isLoggedIn) {
      navigate(routes.account.login, { replace: true });
      return;
    }
    if (readOnboardingCompleted()) {
      // User finished onboarding (most commonly: this screen's own
      // `finish()` flipped the flag, then they hit Back). Preserve the
      // `?onboarding=1` signal so AssistantPageClient drains any
      // sessionStorage handoff that finish() just wrote — without it,
      // a back-nav after finish silently strands the payload until the
      // next page load consumes it spuriously.
      navigate(`${routes.assistant}?onboarding=1`, { replace: true });
      return;
    }
    // Direct-navigation defense: the user can hit /onboarding/prechat
    // before passing through /onboarding/privacy. Without this guard,
    // they'd be able to complete PreChat — which writes
    // `onboarding.completed=true` — and skip TOS entirely. Read the
    // consent decision from the snapshot ref (computed once at the
    // first post-auth render) so a TTL expiry on the in-memory marker
    // doesn't redirect a user who has already started typing.
    if (consentDecision === "missing") {
      navigate(routes.onboarding.privacy, { replace: true });
      return;
    }
    // Still snapshotting consent — wait for the snapshot effect to
    // resolve before deciding whether to proceed or redirect.
    if (consentDecision === "pending") return;
    // `setOnboardingCompleted` is a stable state setter from
    // `useOnboardingCompleted`, but we list it explicitly to satisfy
    // the exhaustive-deps lint rule — matching HatchingScreen's
    // convention.
  }, [
    consentDecision,
    isAuthLoading,
    isLoggedIn,
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
    // When `connectedScopes` is provided (from the onConnect callback),
    // use those values directly instead of reading from React state.
    // React 18+ batches setState calls, so reading `googleConnected` /
    // `googleScopes` state immediately after `setGoogleConnected(true)`
    // would see stale values (false / []) when `finish` runs
    // synchronously in the same event (e.g. desktop web, no app step).
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
    // Stash the assistant name separately so the chat sidebar can show
    // it immediately on first render — before fetchAssistantIdentity
    // resolves. Consume-once: cleared by AssistantPageClient on mount.
    if (trimmedAssistant) setPendingAssistantName(trimmedAssistant);
    // Mark onboarding complete now that the user has reached the end
    // of the flow. HatchingScreen defers this write to us so its own
    // gate doesn't bounce the user past PreChat. Storage may be
    // disabled / over quota — guard the write so a hostile localStorage
    // doesn't block navigation.
    try {
      setOnboardingCompleted(true);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { context: "prechat_mark_onboarding_completed" },
      });
    }
    // Drop the in-memory consent marker now that PreChat is the
    // confirmed end of onboarding. HatchingScreen defers this clear
    // to us so storage-disabled users aren't stranded at the consent
    // gate.
    clearPrivacyConsent();
    navigate(`${routes.assistant}?onboarding=1`, { replace: true });
  }

  // While the gate is deciding (or about to redirect), render nothing
  // rather than a half-mounted screen. This avoids a flash of the tool
  // picker for users who'll be bounced to /assistant, /account/login,
  // or /onboarding/privacy. `readOnboardingCompleted()` is included so
  // browser-back into /onboarding/prechat after `finish()` doesn't
  // briefly re-show the tool screen before the gate effect's
  // /assistant?onboarding=1 redirect lands. localStorage reads are
  // stable here (no TTL), so calling it per render is fine.
  if (
    isAuthLoading ||
    !isLoggedIn ||
    consentDecision !== "ok" ||
    readOnboardingCompleted()
  ) {
    return null;
  }

  // Screen 0: NameExchange
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

  // Screen 1: TaskTone
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

  // Screen 2: ToolSelection
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

  // Screen 3: Google OAuth — only reachable when a Google tool was selected
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

  // Screen 4: GetApp (conditional)
  if (screen === 4) {
    if (isIOSWeb) return <GetIOSAppScreen onComplete={() => finish()} />;
    return <GetMacOSAppScreen onComplete={() => finish()} />;
  }

  return null;
}
