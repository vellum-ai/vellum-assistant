import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Mail } from "lucide-react";

import { Button } from "@vellum/design-library";
import { AppleLogo } from "@/components/icons/apple-logo";
import { GoogleLogo } from "@/components/icons/google-logo";
import { NativeSplash } from "@/components/native-splash";
import { LoginBackground } from "@/domains/account/login-background";
import { PROVIDER_ID, buildProviderCallbackUrl } from "@/domains/account/login-flow";
import { ensureGatewayToken } from "@/lib/auth/gateway-session";
import {
  type LockfileAssistant,
  isLocalMode,
  loadLockfile,
  getLocalAssistants,
  getPlatformAssistants,
  setSelectedAssistantId,
  gatewayProxyUrl,
  fetchGuardianToken,
} from "@/lib/local-mode";
import {
  startAuthFlow,
  startNativeLogin,
  useIsNativePlatform,
} from "@/runtime/native-auth";
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

const CARD_CLASS =
  "flex w-full max-w-[448px] flex-col gap-6 rounded-lg border border-[var(--border-disabled)] bg-[var(--surface-lift)] p-6";

function SignUpFooter({ signUpHref }: { signUpHref: string }) {
  return (
    <p className="text-body-small-default flex justify-center gap-1">
      <span className="text-[var(--content-secondary)]">
        Don&apos;t have an account?
      </span>
      <Link
        to={signUpHref}
        className="font-medium text-[var(--content-emphasised)] hover:underline"
      >
        Sign up
      </Link>
    </p>
  );
}

function LoginCard({ children }: { children: ReactNode }) {
  return <div className={CARD_CLASS}>{children}</div>;
}

/** Forced-dark full-screen shell with the branded gradient background. */
function DarkLoginShell({ children }: { children: ReactNode }) {
  return (
    <div className="dark">
      <div className="relative min-h-screen overflow-x-hidden bg-[var(--surface-base)] text-[var(--content-default)]">
        <LoginBackground />
        <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4">
          {children}
        </div>
      </div>
    </div>
  );
}

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  signup_closed:
    "Sign-ups are currently closed. Visit vellum.ai/community to request access.",
};

/**
 * Capacitor iOS login: single "Sign in" button inside NativeSplash.
 * Opens a Safari sheet via `/accounts/native/start` with no provider
 * hint — WorkOS AuthKit handles Apple / Google / email selection.
 */
function NativeLoginForm({ returnTo }: { returnTo: string | null }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const triggerAuth = async () => {
    setErrorMessage(null);
    setLoading(true);
    try {
      await startNativeLogin({ returnTo: returnTo ?? null });
    } catch (err) {
      const errorCode = (err as { code?: unknown } | null | undefined)?.code;
      if (errorCode === "USER_CANCELLED") {
        setLoading(false);
        return;
      }
      if (errorCode === "AUTH_ERROR") {
        const errorKey =
          (err as { data?: Record<string, unknown> }).data?.authError as string | undefined;
        setErrorMessage(
          (errorKey && AUTH_ERROR_MESSAGES[errorKey]) ?? "Something went wrong. Please try again.",
        );
      } else {
        console.error("[native-auth] auth flow failed:", err);
        setErrorMessage("Something went wrong. Please try again.");
      }
      setLoading(false);
    }
  };

  const handleSignIn = () => {
    void triggerAuth();
  };

  return (
    <NativeSplash>
      <div className="z-10 mt-8 flex w-full max-w-[320px] flex-col items-center gap-3">
        {errorMessage && (
          <p className="text-body-small-default max-w-[280px] text-center text-[var(--system-negative-strong)]">
            {errorMessage}
          </p>
        )}
        <Button
          type="button"
          variant="primary"
          fullWidth
          onClick={handleSignIn}
          disabled={loading}
          className="max-w-[300px]"
        >
          Sign in
        </Button>
      </div>
    </NativeSplash>
  );
}

// ---------------------------------------------------------------------------
// Shared platform sign-in buttons (Apple / Google / Email via WorkOS)
// ---------------------------------------------------------------------------

function PlatformLoginButtons({
  returnTo,
  loading,
  errorMessage,
  onProviderClick,
}: {
  returnTo: string | null;
  loading: boolean;
  errorMessage: string | null;
  onProviderClick: (providerHint?: string) => void;
}) {
  const signUpHref = returnTo
    ? `${routes.account.signup}?returnTo=${encodeURIComponent(returnTo)}`
    : routes.account.signup;

  return (
    <>
      <h1 className="text-title-large text-center text-[var(--content-emphasised)]">
        Sign in to Vellum
      </h1>
      {errorMessage && (
        <p className="text-body-small-default text-center text-[var(--system-negative-strong)]">
          {errorMessage}
        </p>
      )}
      <div className="flex flex-col items-center gap-3">
        <Button
          type="button"
          variant="outlined"
          fullWidth
          onClick={() => onProviderClick("AppleOAuth")}
          disabled={loading}
          leftIcon={<AppleLogo />}
          className="max-w-[300px] gap-3"
        >
          Continue with Apple
        </Button>
        <Button
          type="button"
          variant="outlined"
          fullWidth
          onClick={() => onProviderClick("GoogleOAuth")}
          disabled={loading}
          leftIcon={<GoogleLogo />}
          className="max-w-[300px] gap-3"
        >
          Continue with Google
        </Button>
        <Button
          type="button"
          variant="outlined"
          fullWidth
          onClick={() => onProviderClick()}
          disabled={loading}
          leftIcon={<Mail />}
          className="max-w-[300px] gap-3"
        >
          Continue with Email
        </Button>
      </div>
      <SignUpFooter signUpHref={signUpHref} />
    </>
  );
}

/**
 * Web login form: three equal sign-in buttons routing through WorkOS.
 * Wraps itself in a forced-dark theme context with the branded
 * `LoginBackground` — the web login screen is always dark per Figma.
 */
function WebLoginForm({ returnTo }: { returnTo: string | null }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const callbackUrl = buildProviderCallbackUrl(returnTo);

  const handleProvider = async (providerHint?: string) => {
    setErrorMessage(null);
    setLoading(true);
    try {
      await startAuthFlow(PROVIDER_ID, callbackUrl, {
        ...(providerHint ? { providerHint } : {}),
        returnTo,
      });
    } catch (err) {
      console.error("[web-login] auth flow failed:", err);
      setErrorMessage("Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  return (
    <DarkLoginShell>
      <LoginCard>
        <PlatformLoginButtons
          returnTo={returnTo}
          loading={loading}
          errorMessage={errorMessage}
          onProviderClick={(hint) => {
            void handleProvider(hint);
          }}
        />
      </LoginCard>
    </DarkLoginShell>
  );
}

// ---------------------------------------------------------------------------
// Local-mode login — lockfile-driven conditional rendering
// ---------------------------------------------------------------------------

function LocalModeLoginPage({ returnTo }: { returnTo: string | null }) {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [platformError, setPlatformError] = useState<string | null>(null);
  const [platformLoading, setPlatformLoading] = useState(false);

  // Force re-read of lockfile state when refreshKey changes
  void refreshKey;
  const localAssistants = getLocalAssistants();
  const platformAssistants = getPlatformAssistants();
  const hasLocal = localAssistants.length > 0;
  const hasPlatform = platformAssistants.length > 0;

  const handleRefresh = useCallback(() => {
    void loadLockfile().then(() => setRefreshKey((k) => k + 1));
  }, []);

  const connectToLocal = useCallback(
    async (assistant: LockfileAssistant) => {
      setConnectError(null);
      setConnectingId(assistant.assistantId);
      try {
        const guardianToken = await fetchGuardianToken(assistant.assistantId);
        const tokenUrl = `${gatewayProxyUrl(assistant.resources!.gatewayPort)}/auth/token`;
        setSelectedAssistantId(assistant.assistantId);
        await ensureGatewayToken(tokenUrl, guardianToken);
        await useAuthStore.getState().initSession();
        navigate(returnTo || "/assistant");
      } catch {
        setConnectError(
          "Couldn't connect to your assistant. Make sure it's running.",
        );
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
        const callbackUrl = buildProviderCallbackUrl(returnTo);
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
    [returnTo],
  );

  // Auto-connect when only local assistants are present
  useEffect(() => {
    if (hasLocal && !hasPlatform && !connectingId && !connectError) {
      void connectToLocal(localAssistants[0]!);
    }
    // localAssistants excluded: new array ref each render, guarded by hasLocal
  }, [hasLocal, hasPlatform, connectingId, connectError, connectToLocal]);

  // No assistants at all
  if (!hasLocal && !hasPlatform) {
    return (
      <DarkLoginShell>
        <LoginCard>
          <h1 className="text-title-large text-center text-[var(--content-emphasised)]">
            Vellum
          </h1>
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

  // Only platform assistants — render normal login
  if (hasPlatform && !hasLocal) {
    return <WebLoginForm returnTo={returnTo} />;
  }

  // Only local assistants — auto-connecting state
  if (hasLocal && !hasPlatform) {
    return (
      <DarkLoginShell>
        <LoginCard>
          <h1 className="text-title-large text-center text-[var(--content-emphasised)]">
            Vellum
          </h1>
          {connectError ? (
            <>
              <p className="text-body-small-default text-center text-[var(--system-negative-strong)]">
                {connectError}
              </p>
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="outlined"
                  onClick={() => {
                    void connectToLocal(localAssistants[0]!);
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
          <PlatformLoginButtons
            returnTo={returnTo}
            loading={platformLoading}
            errorMessage={platformError}
            onProviderClick={(hint) => {
              void handlePlatformProvider(hint);
            }}
          />
        </LoginCard>
        <LoginCard>
          <h1 className="text-title-large text-center text-[var(--content-emphasised)]">
            Local Assistant
          </h1>
          {connectError && (
            <p className="text-body-small-default text-center text-[var(--system-negative-strong)]">
              {connectError}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {localAssistants.map((assistant) => (
              <button
                key={assistant.assistantId}
                type="button"
                className="flex w-full items-center justify-between rounded-lg border border-[var(--border-disabled)] bg-[var(--surface-sunken)] px-4 py-3 text-left transition-colors hover:bg-[var(--surface-lift)] disabled:opacity-50"
                disabled={connectingId === assistant.assistantId}
                onClick={() => {
                  void connectToLocal(assistant);
                }}
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-body-small-default text-[var(--content-emphasised)]">
                    {assistant.name || assistant.assistantId}
                  </span>
                  {assistant.species && (
                    <span className="text-body-small-default text-[var(--content-secondary)]">
                      {assistant.species}
                    </span>
                  )}
                </div>
                {connectingId === assistant.assistantId && (
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

/**
 * Branded sign-in screen for `/account/login`.
 *
 * Delegates to `LocalModeLoginPage` (lockfile-driven self-hosted),
 * `NativeLoginForm` (Capacitor iOS), or `WebLoginForm` (standard browser)
 * based on platform detection.
 */
export function LoginPage() {
  const [searchParams] = useSearchParams();
  const isNative = useIsNativePlatform();
  const returnTo = searchParams.get("returnTo");

  if (isLocalMode()) return <LocalModeLoginPage returnTo={returnTo} />;
  if (isNative) return <NativeLoginForm returnTo={returnTo} />;
  return <WebLoginForm returnTo={returnTo} />;
}
