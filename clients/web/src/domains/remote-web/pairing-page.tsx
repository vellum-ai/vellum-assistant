import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  Smartphone,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { NotFound } from "@/components/not-found";
import {
  activateRemoteGatewaySession,
  createRemoteWebPairingChallenge,
  exchangeRemoteWebPairingToken,
  parseRemoteWebPairingParams,
  RemoteWebPairingError,
} from "@/lib/auth/remote-gateway-session";
import { isRemoteGatewayMode } from "@/lib/local-mode";
import { isNativePlatform } from "@/runtime/native-auth";
import { isIOSBrowser } from "@/runtime/platform-detection";
import { sanitizeReturnTo } from "@/utils/return-to";
import { routes } from "@/utils/routes";

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
        body: "This pairing code is invalid or expired. Run vellum pair --qr (or vellum pair --web) on the machine running your assistant to get a new one.",
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
    return <CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden />;
  }
  if (state.kind === "handoff_choice") {
    return <Smartphone className="h-5 w-5 text-blue-600" aria-hidden />;
  }
  if (
    state.kind === "starting" ||
    state.kind === "verifying" ||
    state.kind === "polling"
  ) {
    return (
      <LoaderCircle
        className="h-5 w-5 animate-spin text-blue-600"
        aria-hidden
      />
    );
  }
  return <AlertCircle className="h-5 w-5 text-red-600" aria-hidden />;
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
 * Custom URL scheme registered by the shipped iOS app. Dev and staging app
 * builds register suffixed schemes (e.g. `vellum-assistant-dev`), so this
 * handoff link intentionally targets the production app — the common case for
 * a phone that scanned a pairing QR with its camera.
 */
const VELLUM_APP_SCHEME = "vellum-assistant";

/**
 * Build the `vellum-assistant://connect?url=<origin>&code=<device-code>` deep
 * link the iOS app consumes to persist this server and finish pairing inside
 * the app. `url` is the page's own origin so the app reconnects to the same
 * self-hosted assistant this browser is already on.
 */
function buildAppHandoffUrl(deviceCode: string): string {
  const query = new URLSearchParams({
    url: window.location.origin,
    code: deviceCode,
  });
  return `${VELLUM_APP_SCHEME}://connect?${query.toString()}`;
}

/**
 * Pre-exchange choice shown to an iOS browser that arrived with a device code.
 * The primary action is a plain anchor so Safari performs the custom-scheme
 * navigation natively; tapping it does not burn the single-use code, so
 * "Continue in this browser" stays available if the app is not installed.
 */
function PairingHandoffActions({
  deviceCode,
  onContinueInBrowser,
}: {
  deviceCode: string;
  onContinueInBrowser: () => void;
}) {
  const appLink = useMemo(() => buildAppHandoffUrl(deviceCode), [deviceCode]);

  return (
    <div className="mt-6 flex flex-col gap-3">
      <a
        href={appLink}
        className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
      >
        Open in the Vellum app
      </a>
      <button
        type="button"
        onClick={onContinueInBrowser}
        className="inline-flex items-center justify-center rounded-md border border-[var(--border-default)] bg-[var(--background-surface)] px-4 py-2.5 text-sm font-medium text-[var(--content-primary)] transition-colors hover:bg-[var(--background-muted)]"
      >
        Continue in this browser
      </button>
    </div>
  );
}

export function RemoteWebPairingPage() {
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

  // A phone that scanned the pairing QR with its camera lands here in Safari.
  // If the Vellum app is installed we offer to hand the pairing to it before
  // burning the single-use code — but only in an iOS browser, never inside the
  // app's own WKWebView (which pairs directly).
  const iosAppHandoff = useMemo(
    () => Boolean(params.deviceCode) && isIOSBrowser() && !isNativePlatform(),
    [params.deviceCode],
  );

  const [pairing, setPairing] = useState<PairingDetails | null>(() =>
    params.deviceCode
      ? {
          deviceCode: params.deviceCode,
          userCode: params.userCode,
        }
      : null,
  );

  // The browser-side exchange burns the single-use code, so on the iOS handoff
  // screen it waits until the user picks "Continue in this browser"; every
  // other surface starts it immediately.
  const [browserExchangeAllowed, setBrowserExchangeAllowed] = useState(
    () => !iosAppHandoff,
  );

  const [state, setState] = useState<PairingState>(() => {
    if (iosAppHandoff) {
      return { kind: "handoff_choice" };
    }
    return params.deviceCode ? { kind: "verifying" } : { kind: "starting" };
  });

  useEffect(() => {
    if (!enabled) return;
    if (pairing) return;

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
        if (controller.signal.aborted) return;
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
    if (!enabled) return;
    if (!pairing?.deviceCode) {
      return;
    }
    // Hold the code-burning exchange while the iOS handoff choice is pending.
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
        if (controller.signal.aborted) return;
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
      if (timeout) clearTimeout(timeout);
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

  if (!enabled) {
    return <NotFound />;
  }

  const copy = statusCopy(state);

  return (
    <main className="flex min-h-svh items-center justify-center bg-[var(--background-default)] px-6 py-10 text-[var(--content-primary)]">
      <section className="w-full max-w-md rounded-lg border border-[var(--border-default)] bg-[var(--background-surface)] p-8 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <StatusIcon state={state} />
          <h1 className="text-xl font-semibold">{copy.title}</h1>
        </div>

        {state.kind === "polling" && pairing?.userCode ? (
          <div className="mb-5 rounded-md border border-[var(--border-subtle)] bg-[var(--background-muted)] p-4 text-center">
            <div className="text-xs font-medium uppercase text-[var(--content-secondary)]">
              Pairing code
            </div>
            <div className="mt-2 font-mono text-3xl font-semibold tracking-[0.18em]">
              {pairing.userCode}
            </div>
          </div>
        ) : null}

        <p className="text-sm leading-6 text-[var(--content-secondary)]">
          {copy.body}
        </p>

        {state.kind === "handoff_choice" && pairing ? (
          <PairingHandoffActions
            deviceCode={pairing.deviceCode}
            onContinueInBrowser={handleContinueInBrowser}
          />
        ) : null}

        {state.kind === "polling" && state.expiresAt ? (
          <p className="mt-4 text-xs text-[var(--content-tertiary)]">
            Expires {new Date(state.expiresAt).toLocaleTimeString()}.
          </p>
        ) : null}
      </section>
    </main>
  );
}
