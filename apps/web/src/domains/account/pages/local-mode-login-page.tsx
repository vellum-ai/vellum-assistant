import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@vellumai/design-library";

import {
    DarkLoginShell,
    LoginCard,
    LoginErrorText,
    LoginHeading,
} from "@/domains/account/components/login-shell";
import { PlatformLoginButtons } from "@/domains/account/components/platform-login-buttons";
import { PROVIDER_ID, buildProviderCallbackUrl } from "@/domains/account/login-flow";
import { useIsPlatformLocal } from "@/lib/auth/loopback-auth";
import {
    getActiveAssistant,
    loadLockfile,
} from "@/lib/local-mode";
import { captureError, normalizeToError } from "@/lib/sentry/capture-error";
import { isElectron } from "@/runtime/is-electron";
import { startAuthFlow } from "@/runtime/native-auth";
import { useAuthStore } from "@/stores/auth-store";
import {
    useResolvedAssistantsStore,
    type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";

interface ConnectError {
  message: string;
  detail: string | null;
}

/** Connect-failure headline plus the underlying reason, when available. */
function ConnectErrorMessage({ error }: { error: ConnectError | null }) {
  if (!error) return null;
  return (
    <>
      <LoginErrorText>{error.message}</LoginErrorText>
      {error.detail && (
        <p className="text-body-small-default text-center text-[var(--content-secondary)] break-words">
          {error.detail}
        </p>
      )}
    </>
  );
}

/**
 * Lockfile-driven self-hosted login for `/account/login`.
 *
 * Renders one of four states based on resolved assistants: no assistants
 * (hatch prompt / platform sign-in), platform-only (redirect to sign-in),
 * local-only (auto-connect to the active assistant), or mixed (two-card
 * picker).
 */
export function LocalModeLoginPage({ returnTo }: { returnTo: string | null }) {
  const navigate = useNavigate();
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<ConnectError | null>(null);
  const [platformError, setPlatformError] = useState<string | null>(null);
  const [platformLoading, setPlatformLoading] = useState(false);
  const isPlatformLocal = useIsPlatformLocal();

  const assistants = useResolvedAssistantsStore.use.assistants();
  const localAssistants = assistants.filter((a) => a.isLocal);
  const platformAssistants = assistants.filter((a) => !a.isLocal);
  const hasLocal = localAssistants.length > 0;
  const hasPlatform = platformAssistants.length > 0;

  // Auto-connect targets the active assistant, falling back to the first local
  // entry only when the active id is stale — so a stale entry never shadows the
  // real active assistant.
  const autoConnectId =
    hasLocal && !hasPlatform
      ? (getActiveAssistant()?.assistantId ?? localAssistants[0]?.id)
      : undefined;

  const callbackUrl = buildProviderCallbackUrl(returnTo);

  const handleRefresh = useCallback(() => {
    void loadLockfile();
  }, []);

  const connectToLocal = useCallback(
    async (assistantId: string) => {
      setConnectError(null);
      setConnectingId(assistantId);
      try {
        await useAuthStore.getState().connectLocalAssistant(assistantId);
        navigate(returnTo || "/assistant");
      } catch (err) {
        captureError(err, {
          context: "local-login.connect",
          extra: { assistantId },
        });
        setConnectError({
          message:
            "Couldn't connect to your assistant. Make sure it's running.",
          detail: normalizeToError(err).message,
        });
        setConnectingId(null);
      }
    },
    [navigate, returnTo],
  );

  const handlePlatformProvider = useCallback(
    async (providerHint?: string) => {
      setPlatformError(null);
      setPlatformLoading(true);
      try {
        await startAuthFlow(PROVIDER_ID, callbackUrl, {
          ...(providerHint ? { providerHint } : {}),
          returnTo,
        });
      } catch (err) {
        console.error("[local-login] platform auth flow failed:", err);
        setPlatformError("Something went wrong. Please try again.");
        setPlatformLoading(false);
      }
    },
    [returnTo, isPlatformLocal, callbackUrl],
  );

  const handleProviderClick = useCallback(
    (hint?: string) => {
      void handlePlatformProvider(hint);
    },
    [handlePlatformProvider],
  );

  // Auto-connect when only local assistants are present.
  useEffect(() => {
    if (autoConnectId && !connectingId && !connectError) {
      void connectToLocal(autoConnectId);
    }
  }, [autoConnectId, connectingId, connectError, connectToLocal]);

  // Auto-redirect to platform login when only platform assistants exist
  // and we're in standalone mode (no local Django).
  useEffect(() => {
    if (
      hasPlatform &&
      !hasLocal &&
      !platformLoading &&
      !platformError &&
      isPlatformLocal === false
    ) {
      setPlatformLoading(true);
      void handlePlatformProvider();
    }
  }, [
    hasPlatform,
    hasLocal,
    platformLoading,
    platformError,
    isPlatformLocal,
    handlePlatformProvider,
  ]);

  // The platform sign-in card is shared by the no-assistants and
  // platform-only states whenever this build embeds a local Django.
  const platformLoginCard = (
    <DarkLoginShell>
      <LoginCard>
        <PlatformLoginButtons
          returnTo={returnTo}
          loading={platformLoading}
          errorMessage={platformError}
          onProviderClick={handleProviderClick}
        />
      </LoginCard>
    </DarkLoginShell>
  );

  if (!hasLocal && (isPlatformLocal || isElectron())) {
    return platformLoginCard;
  }

  // No assistants at all — prompt the user to hatch via CLI.
  if (!hasLocal && !hasPlatform) {
    return (
      <DarkLoginShell>
        <LoginCard>
          <LoginHeading>Vellum</LoginHeading>
          <p className="text-body-small-default text-center text-[var(--content-secondary)]">
            No assistants found. Hatch one via CLI (
            <code className="rounded bg-[var(--surface-sunken)] px-1 py-0.5 text-[var(--content-default)]">
              vellum hatch
            </code>
            ) or the Mac app to get started.
          </p>
          <div className="flex justify-center">
            <Button type="button" variant="outlined" onClick={handleRefresh}>
              Refresh
            </Button>
          </div>
        </LoginCard>
      </DarkLoginShell>
    );
  }

  // Only platform assistants — redirect to sign in (the platform-local
  // case already returned the shared sign-in card above).
  if (hasPlatform && !hasLocal) {
    return (
      <DarkLoginShell>
        <LoginCard>
          <LoginHeading>Vellum</LoginHeading>
          {platformError ? (
            <>
              <LoginErrorText>{platformError}</LoginErrorText>
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => {
                    setPlatformError(null);
                  }}
                >
                  Retry
                </Button>
              </div>
            </>
          ) : (
            <p className="text-body-small-default text-center text-[var(--content-secondary)]">
              Redirecting to sign in...
            </p>
          )}
        </LoginCard>
      </DarkLoginShell>
    );
  }

  // Only local assistants — auto-connecting state
  if (hasLocal && !hasPlatform) {
    return (
      <DarkLoginShell>
        <LoginCard>
          <LoginHeading>Vellum</LoginHeading>
          {connectError ? (
            <>
              <ConnectErrorMessage error={connectError} />
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => {
                    if (autoConnectId) void connectToLocal(autoConnectId);
                  }}
                >
                  Retry
                </Button>
              </div>
            </>
          ) : (
            <p className="text-body-small-default text-center text-[var(--content-secondary)]">
              {connectingId
                ? "Connecting to your assistant..."
                : "Preparing connection..."}
            </p>
          )}
        </LoginCard>
      </DarkLoginShell>
    );
  }

  // Mixed: platform + local assistants — two-card layout
  return (
    <DarkLoginShell>
      <div className="flex w-full max-w-[960px] flex-col items-start justify-center gap-6 md:flex-row">
        <LoginCard>
          {isPlatformLocal ? (
            <PlatformLoginButtons
              returnTo={returnTo}
              loading={platformLoading}
              errorMessage={platformError}
              onProviderClick={handleProviderClick}
            />
          ) : (
            <>
              <LoginHeading>Vellum Cloud</LoginHeading>
              {platformError && <LoginErrorText>{platformError}</LoginErrorText>}
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="primary"
                  fullWidth
                  onClick={() => {
                    void handlePlatformProvider();
                  }}
                  disabled={platformLoading}
                  className="max-w-[300px]"
                >
                  {platformLoading ? "Redirecting…" : "Sign in"}
                </Button>
              </div>
            </>
          )}
        </LoginCard>
        <LoginCard>
          <LoginHeading>Local Assistant</LoginHeading>
          <ConnectErrorMessage error={connectError} />
          <div className="flex flex-col gap-2">
            {localAssistants.map((assistant) => (
              <button
                key={assistant.id}
                type="button"
                className="flex w-full items-center justify-between rounded-lg border border-[var(--border-disabled)] bg-[var(--surface-sunken)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-lift)] disabled:opacity-50"
                disabled={connectingId === assistant.id}
                onClick={() => {
                  void connectToLocal(assistant.id);
                }}
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-body-small-default text-[var(--content-emphasised)]">
                    {assistant.name || assistant.id}
                  </span>
                </div>
                {connectingId === assistant.id && (
                  <span className="text-body-small-default text-[var(--content-secondary)]">
                    Connecting...
                  </span>
                )}
              </button>
            ))}
          </div>
        </LoginCard>
      </div>
    </DarkLoginShell>
  );
}
