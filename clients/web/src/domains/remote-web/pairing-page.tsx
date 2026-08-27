import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  Smartphone,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { Button } from "@vellumai/design-library/components/button";

import { NotFound } from "@/components/not-found";
import {
  activateRemoteGatewaySession,
  createRemoteWebPairingChallenge,
  exchangeRemoteWebPairingToken,
  parseRemoteWebPairingParams,
  remoteGatewayPublicBaseUrl,
  RemoteWebPairingError,
} from "@/lib/auth/remote-gateway-session";
import {
  getRemoteGatewayAssistantName,
  getRemoteGatewayHubUrl,
  isRemoteGatewayMode,
} from "@/lib/local-mode";
import { isNativePlatform } from "@/runtime/native-auth";
import { isAndroidBrowser, isIOSBrowser } from "@/runtime/platform-detection";
import { nativeSwitchToOriginPath } from "@/runtime/self-hosted-servers";
import { sanitizeReturnTo } from "@/utils/return-to";
import { routes } from "@/utils/routes";

import { useTranslation } from "@/i18n";

type PairingDetails = {
  deviceCode: string;
  userCode: string | null;
};

type PairingState =
  | { kind: "starting" }
  | { kind: "handoff_choice" }
  | { kind: "verifying" }
  | { kind: "polling"; expiresAt: string | null }
  | { kind: "approved" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

function statusCopy(state: PairingState): { title: string; body: string } {
  switch (state.kind) {
    case "starting":
      return {
        title: "Starting pairing",
        body: "Creating a code for this browser.",
      };
    case "handoff_choice":
      return {
        title: "Open in the Vellum app",
        body: "Scanning from a phone with the Vellum app installed? Hand this pairing to the app.",
      };
    case "verifying":
      return {
        title: "Pairing",
        body: "Connecting this device to your assistant.",
      };
    case "approved":
      return {
        title: "Connected",
        body: "Opening your assistant.",
      };
    case "expired":
      return {
        title: "Pairing expired",
        body: "This pairing code is invalid or expired. Run vellum pair on the machine running your assistant to get a new one.",
      };
    case "error":
      return {
        title: "Pairing failed",
        body: state.message,
      };
    case "polling":
      return {
        title: "Waiting for approval",
        body: "Confirm this code on the machine running your assistant.",
      };
  }
}

function StatusIcon({ state }: { state: PairingState }) {
  if (state.kind === "approved") {
    return (
      <CheckCircle2
        className="h-5 w-5 text-[var(--system-positive-strong)]"
        aria-hidden
      />
    );
  }
  if (state.kind === "handoff_choice") {
    return (
      <Smartphone
        className="h-5 w-5 text-[var(--system-info-strong)]"
        aria-hidden
      />
    );
  }
  if (
    state.kind === "starting" ||
    state.kind === "verifying" ||
    state.kind === "polling"
  ) {
    return (
      <LoaderCircle
        className="h-5 w-5 animate-spin text-[var(--system-info-strong)]"
        aria-hidden
      />
    );
  }
  return (
    <AlertCircle
      className="h-5 w-5 text-[var(--system-negative-strong)]"
      aria-hidden
    />
  );
}

/**
 * Strip the burned `#device_code=` fragment (and any query variants) from the
 * address bar after a successful exchange, preserving `returnTo`, so the spent
 * code does not linger in the location bar or get re-submitted on reload.
 */
function clearDeviceCodeFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    for (const key of ["deviceCode", "device_code", "userCode", "user_code"]) {
      url.searchParams.delete(key);
    }
    url.hash = "";
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  } catch {
    // history.replaceState unavailable — the burned code is inert regardless.
  }
}

/**
 * Custom URL scheme registered by the shipped mobile apps. Dev and staging app
 * builds register suffixed schemes (e.g. `vellum-assistant-dev`), so this
 * handoff link intentionally targets the production app — the common case for
 * a phone that scanned a pairing QR with its camera.
 */
const VELLUM_APP_SCHEME = "vellum-assistant";
const VELLUM_ANDROID_PACKAGE = "ai.vellum.assistant";
type AppHandoffPlatform = "ios" | "android";

/**
 * Build the `vellum-assistant://connect?url=<base>&code=<device-code>` deep
 * link the mobile app consumes to persist this server and finish pairing inside
 * the app. `url` is the page's own public base (origin + served path prefix)
 * so the app reconnects to the same self-hosted assistant this browser is
 * already on. When the served config carries the assistant's display name, a
 * `name` param rides along so the app can label the server.
 */
function buildAppHandoffUrl(
  deviceCode: string,
  platform: AppHandoffPlatform,
): string {
  const params = new URLSearchParams({
    url: remoteGatewayPublicBaseUrl(),
    code: deviceCode,
  });
  const assistantName = getRemoteGatewayAssistantName();
  if (assistantName) {
    params.set("name", assistantName);
  }
  // Percent-encode spaces: URLSearchParams form-encodes them as `+`, which
  // the iOS app's Foundation URLComponents parser keeps as a literal plus.
  const query = params.toString().replace(/\+/g, "%20");
  if (platform === "ios") {
    return `${VELLUM_APP_SCHEME}://connect?${query}`;
  }

  const fallbackUrl = encodeURIComponent(window.location.href);
  return (
    `intent://connect?${query}` +
    `#Intent;scheme=${VELLUM_APP_SCHEME};` +
    `package=${VELLUM_ANDROID_PACKAGE};` +
    `S.browser_fallback_url=${fallbackUrl};end`
  );
}

/**
 * The hub's chooser on its own origin, or `null` when the served config names
 * no hub. Abandoning a pairing has to leave this origin: the chooser sits
 * behind `requireRemoteGatewayPairing`, which bounces an unauthenticated visit
 * straight back here and mints a fresh code. `noAutoSkip` keeps the hub on the
 * chooser instead of skipping through a lone assistant.
 */
function hubChooserUrl(): string | null {
  const hubUrl = getRemoteGatewayHubUrl();
  if (!hubUrl) {
    return null;
  }
  try {
    return `${new URL(hubUrl).origin}${routes.selectAssistant}?noAutoSkip=1`;
  } catch {
    return null;
  }
}

/**
 * Pre-exchange choice shown to a mobile browser that arrived with a device
 * code. The primary action is a plain anchor so the browser performs the
 * custom-scheme navigation natively; tapping it does not burn the code, so
 * "Continue in this browser" stays available if the app is not installed.
 */
function PairingHandoffActions({
  deviceCode,
  platform,
  onContinueInBrowser,
}: {
  deviceCode: string;
  platform: AppHandoffPlatform;
  onContinueInBrowser: () => void;
}) {
  const { t } = useTranslation("remote-web");
  const appLink = useMemo(
    () => buildAppHandoffUrl(deviceCode, platform),
    [deviceCode, platform],
  );

  return (
    <div className="mt-6 flex flex-col gap-3">
      <Button variant="primary" fullWidth asChild>
        <a href={appLink}>{t("pairingPage.openInApp")}</a>
      </Button>
      <Button variant="outlined" fullWidth onClick={onContinueInBrowser}>
        {t("pairingPage.continueInBrowser")}
      </Button>
    </div>
  );
}

export function RemoteWebPairingPage() {
  const { t } = useTranslation("remote-web");
  const location = useLocation();
  const navigate = useNavigate();
  const enabled = isRemoteGatewayMode();
  const returnTo = useMemo(() => {
    const value = new URLSearchParams(location.search).get("returnTo");
    return sanitizeReturnTo(value, routes.assistant);
  }, [location.search]);
  const params = useMemo(
    () =>
      parseRemoteWebPairingParams(
        `${location.pathname}${location.search}${location.hash}`,
      ),
    [location.pathname, location.search, location.hash],
  );

  // A phone that scanned the pairing QR with its camera lands here in a browser.
  // If the Vellum app is installed we offer to hand the pairing to it before
  // burning the single-use code, never inside a native shell that pairs directly.
  const appHandoffPlatform = useMemo<AppHandoffPlatform | null>(() => {
    if (!params.deviceCode || isNativePlatform()) {
      return null;
    }
    if (isAndroidBrowser()) {
      return "android";
    }
    return isIOSBrowser() ? "ios" : null;
  }, [params.deviceCode]);

  const [pairing, setPairing] = useState<PairingDetails | null>(() =>
    params.deviceCode
      ? {
          deviceCode: params.deviceCode,
          userCode: params.userCode,
        }
      : null,
  );

  // The browser-side exchange burns the single-use code, so on the app handoff
  // screen it waits until the user picks "Continue in this browser"; every
  // other surface starts it immediately.
  const [browserExchangeAllowed, setBrowserExchangeAllowed] = useState(
    () => !appHandoffPlatform,
  );

  const [state, setState] = useState<PairingState>(() => {
    if (appHandoffPlatform) {
      return { kind: "handoff_choice" };
    }
    return params.deviceCode ? { kind: "verifying" } : { kind: "starting" };
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (pairing) {
      return;
    }

    const controller = new AbortController();

    const createChallenge = async () => {
      try {
        const challenge = await createRemoteWebPairingChallenge(
          controller.signal,
        );
        setPairing({
          deviceCode: challenge.deviceCode,
          userCode: challenge.userCode,
        });
        setState({ kind: "polling", expiresAt: challenge.expiresAt });
      } catch {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          kind: "error",
          message:
            "The assistant could not start pairing. Refresh the page to try again.",
        });
      }
    };

    void createChallenge();

    return () => {
      controller.abort();
    };
  }, [enabled, pairing]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (!pairing?.deviceCode) {
      return;
    }
    // Hold the code-burning exchange while the app handoff choice is pending.
    if (!browserExchangeAllowed) {
      return;
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const result = await exchangeRemoteWebPairingToken(
          pairing.deviceCode,
          controller.signal,
        );
        if (result.status === "pending") {
          setState({ kind: "polling", expiresAt: result.expiresAt || null });
          timeout = setTimeout(
            () => void poll(),
            Math.max(1, result.intervalSeconds) * 1000,
          );
          return;
        }

        activateRemoteGatewaySession(result);
        // Drop the burned device code from the URL before navigating so it
        // never lingers in the address bar or re-submits on reload.
        clearDeviceCodeFromUrl();
        setState({ kind: "approved" });
        timeout = setTimeout(() => navigate(returnTo, { replace: true }), 250);
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        if (err instanceof RemoteWebPairingError && err.status === 401) {
          setState({ kind: "expired" });
          return;
        }
        if (
          err instanceof RemoteWebPairingError &&
          err.code === "GUARDIAN_REPAIR_REQUIRED"
        ) {
          // A new pairing would hit the same failure; the approved code stays
          // exchangeable after guardian repair, so point at repair + retry.
          setState({
            kind: "error",
            message:
              "The assistant's trust database needs repair. Run guardian repair on the machine hosting the assistant, then retry this same pairing link — the code stays valid.",
          });
          return;
        }
        setState({
          kind: "error",
          message:
            "The assistant could not complete pairing. Try starting a new pairing.",
        });
      }
    };

    void poll();

    return () => {
      controller.abort();
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }, [
    enabled,
    pairing?.deviceCode,
    browserExchangeAllowed,
    navigate,
    returnTo,
  ]);

  const handleContinueInBrowser = useCallback(() => {
    setBrowserExchangeAllowed(true);
    setState({ kind: "verifying" });
  }, []);

  const cancelUrl = useMemo(() => hubChooserUrl(), []);
  const handleCancel = useCallback(() => {
    void nativeSwitchToOriginPath(null, `select-assistant?noAutoSkip=1`).then(
      (switched) => {
        if (!switched && cancelUrl) {
          window.location.assign(cancelUrl);
        }
      },
    );
  }, [cancelUrl]);

  if (!enabled) {
    return <NotFound />;
  }

  const copy = statusCopy(state);

  return (
    <main className="flex min-h-svh items-center justify-center bg-[var(--surface-base)] px-6 py-10 text-[var(--content-default)]">
      <section className="w-full max-w-md rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-8 shadow-[var(--shadow-sm)]">
        <div className="mb-5 flex items-center gap-3">
          <StatusIcon state={state} />
          <h1 className="text-title-medium text-[var(--content-emphasised)]">
            {copy.title}
          </h1>
        </div>

        {state.kind === "polling" && pairing?.userCode ? (
          <div className="mb-5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-4 text-center">
            <div className="text-label-small-default uppercase tracking-wide text-[var(--content-tertiary)]">
              {t("pairingPage.pairingCode")}
            </div>
            <div className="mt-2 font-mono text-3xl font-semibold tracking-[0.18em] text-[var(--content-emphasised)]">
              {pairing.userCode}
            </div>
          </div>
        ) : null}

        <p className="text-body-medium-lighter leading-6 text-[var(--content-secondary)]">
          {copy.body}
        </p>

        {state.kind === "handoff_choice" && pairing && appHandoffPlatform ? (
          <PairingHandoffActions
            deviceCode={pairing.deviceCode}
            platform={appHandoffPlatform}
            onContinueInBrowser={handleContinueInBrowser}
          />
        ) : null}

        {state.kind === "polling" && state.expiresAt ? (
          <p className="text-body-small-lighter mt-4 text-[var(--content-tertiary)]">
            {t("pairingPage.expiresAt", {
              time: new Date(state.expiresAt).toLocaleTimeString(),
            })}
          </p>
        ) : null}

        {state.kind === "polling" && cancelUrl ? (
          <Button
            variant="outlined"
            fullWidth
            className="mt-6"
            onClick={handleCancel}
          >
            {t("pairingPage.cancel")}
          </Button>
        ) : null}
      </section>
    </main>
  );
}
