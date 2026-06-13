import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CloudAssistant } from '../background/cloud-api.js';
import type { OperationEntry } from '../background/event-log.js';
import { AppContext, type Screen } from './AppContext.js';
import { useSession } from './hooks/use-session.js';
import { useStatusPoll } from './hooks/use-status-poll.js';
import { sendMessage } from './lib/chrome-message.js';
import { ActivityScreen } from './screens/ActivityScreen.js';
import { DetailScreen } from './screens/DetailScreen.js';
import { FeedbackScreen } from './screens/FeedbackScreen.js';
import { MainScreen } from './screens/MainScreen.js';
import { PickerScreen } from './screens/PickerScreen.js';
import { WelcomeScreen } from './screens/WelcomeScreen.js';

export function App() {
  const session = useSession();
  const [screen, setScreen] = useState<Screen>({ name: 'welcome' });
  const [mode, setMode] = useState<'self-hosted' | 'cloud' | null>(null);
  const [operationCount, setOperationCount] = useState(0);
  const [selfHostedPaired, setSelfHostedPaired] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [assistantsError, setAssistantsError] = useState<string | null>(null);
  const [cloudEmail, setCloudEmail] = useState<string | undefined>(undefined);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Determine initial screen from session state once loading completes
  useEffect(() => {
    if (session.loading) return;

    if (session.mode === 'self-hosted') {
      setMode('self-hosted');
      setSelfHostedPaired(!!session.selfHostedPaired);
      setScreen({ name: 'main' });
      if (session.selfHostedPaired) {
        sendMessage({ type: 'connect' });
      }
    } else if (session.mode === 'cloud') {
      setMode('cloud');
      if (session.session?.email) {
        setCloudEmail(session.session.email);
      }
      if (session.session && !session.selectedAssistant) {
        // Signed in but no assistant chosen — go to picker
        sendMessage<{
          ok: boolean;
          assistants?: CloudAssistant[];
          error?: string;
        }>({ type: 'list-assistants' }).then((response) => {
          if (modeRef.current !== 'cloud') return;
          if (response?.ok && response.assistants) {
            setScreen({
              name: 'picker',
              assistants: response.assistants,
              email: session.session?.email,
            });
          } else {
            setScreen({ name: 'welcome' });
          }
        });
      } else {
        setScreen({ name: 'main' });
        sendMessage({ type: 'connect' });
      }
    } else {
      setScreen({ name: 'welcome' });
    }
  }, [session.loading, session.mode, session.session, session.selectedAssistant, session.selfHostedPaired]);

  // Poll status when on the main screen
  const { health, healthDetail, authProfile } = useStatusPoll(screen.name === 'main');

  // Refresh activity count when on the main screen (poll every 2s)
  useEffect(() => {
    if (screen.name !== 'main') return;

    function refreshCount() {
      sendMessage<{ ok: boolean; operations: OperationEntry[] }>({
        type: 'get-operations',
      }).then((response) => {
        if (response?.ok) {
          setOperationCount(response.operations.length);
        }
      });
    }

    refreshCount();
    const interval = setInterval(refreshCount, 2000);
    return () => clearInterval(interval);
  }, [screen.name]);

  // Navigate to picker when assistant is removed
  useEffect(() => {
    if (health !== 'assistant_gone') return;

    sendMessage<{
      ok: boolean;
      assistants?: CloudAssistant[];
      error?: string;
    }>({ type: 'list-assistants' }).then((response) => {
      if (response?.ok && response.assistants) {
        setScreen({ name: 'picker', assistants: response.assistants, email: cloudEmail });
      }
    });
  }, [health, cloudEmail]);

  // Navigation callbacks

  const handleSignIn = useCallback(() => {
    setSigningIn(true);
    setSignInError(null);
    setAssistantsError(null);

    sendMessage<{
      ok: boolean;
      session?: { email: string };
      assistants?: CloudAssistant[];
      assistantsError?: string;
      error?: string;
      cancelled?: boolean;
    }>({ type: 'cloud-login' }).then((response) => {
      setSigningIn(false);

      if (!response?.ok) {
        // User dismissed the auth window — return to the idle state quietly.
        if (response?.cancelled) {
          return;
        }
        setSignInError(response?.error ?? 'Sign-in failed. Please try again.');
        return;
      }

      setMode('cloud');
      if (response.session?.email) {
        setCloudEmail(response.session.email);
      }
      const assistants = response.assistants ?? [];

      if (response.assistantsError) {
        setAssistantsError(response.assistantsError);
        setScreen({ name: 'main' });
        sendMessage({ type: 'connect' });
      } else if (assistants.length === 0) {
        setScreen({ name: 'main' });
        sendMessage({ type: 'connect' });
      } else if (assistants.length === 1) {
        const a = assistants[0]!;
        sendMessage({
          type: 'select-assistant',
          assistantId: a.id,
          assistantName: a.name,
        });
        setScreen({ name: 'main' });
        sendMessage({ type: 'connect' });
      } else {
        setScreen({
          name: 'picker',
          assistants,
          email: response.session?.email,
        });
      }
    });
  }, []);

  const handleRetryAssistants = useCallback(() => {
    setAssistantsError(null);
    handleSignIn();
  }, [handleSignIn]);

  const handleSelfHosted = useCallback(() => {
    setMode('self-hosted');
    sendMessage({ type: 'set-mode', mode: 'self-hosted' });
    setScreen({ name: 'main' });
  }, []);

  const handleSelectAssistant = useCallback(
    (id: string, name: string) => {
      setMode('cloud');
      sendMessage({ type: 'select-assistant', assistantId: id, assistantName: name });
      setScreen({ name: 'main' });
      sendMessage({ type: 'connect' });
    },
    [],
  );

  const handleSignOut = useCallback(() => {
    const msgType = mode === 'self-hosted' ? 'self-hosted-disconnect' : 'cloud-logout';
    sendMessage({ type: msgType }).then(() => {
      setMode(null);
      setAssistantsError(null);
      setScreen({ name: 'welcome' });
    });
  }, [mode]);

  const handleSelectOperation = useCallback((op: OperationEntry) => {
    setScreen({ name: 'detail', operation: op });
  }, []);

  const handleBackToMain = useCallback(() => {
    setScreen({ name: 'main' });
  }, []);

  const handleBackToActivity = useCallback(() => {
    setScreen({ name: 'activity' });
  }, []);

  const handleBackToWelcome = useCallback(() => {
    setScreen({ name: 'welcome' });
  }, []);

  const contextValue = useMemo(
    () => ({
      mode,
      health,
      healthDetail,
      authProfile,
      operationCount,
      selfHostedPaired,
      assistantsError,
      setScreen,
      onSignOut: handleSignOut,
      onRetryAssistants: handleRetryAssistants,
    }),
    [mode, health, healthDetail, authProfile, operationCount, selfHostedPaired, assistantsError, handleSignOut, handleRetryAssistants],
  );

  if (session.loading) {
    return null;
  }

  return (
    <AppContext.Provider value={contextValue}>
      {(() => {
        switch (screen.name) {
          case 'welcome':
            return (
              <WelcomeScreen
                onSignIn={handleSignIn}
                onSelfHosted={handleSelfHosted}
                signingIn={signingIn}
                signInError={signInError}
              />
            );
          case 'picker':
            return (
              <PickerScreen
                assistants={screen.assistants}
                email={screen.email}
                onSelect={handleSelectAssistant}
                onBack={handleBackToWelcome}
              />
            );
          case 'main':
            return <MainScreen />;
          case 'activity':
            return (
              <ActivityScreen
                onBack={handleBackToMain}
                onSelectOperation={handleSelectOperation}
              />
            );
          case 'detail':
            return (
              <DetailScreen
                operation={screen.operation}
                onBack={handleBackToActivity}
              />
            );
          case 'feedback':
            return <FeedbackScreen onBack={handleBackToMain} />;
        }
      })()}
    </AppContext.Provider>
  );
}
