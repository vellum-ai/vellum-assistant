import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { NotFound } from "@/components/not-found";
import {
  activateRemoteGatewaySession,
  exchangeRemoteWebPairingToken,
  parseRemoteWebPairingParams,
  RemoteWebPairingError,
} from "@/lib/auth/remote-gateway-session";
import { isRemoteGatewayMode } from "@/lib/local-mode";
import { routes } from "@/utils/routes";

type PairingState =
  | { kind: "missing" }
  | { kind: "polling"; expiresAt: string | null }
  | { kind: "approved" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

function statusCopy(state: PairingState): { title: string; body: string } {
  switch (state.kind) {
    case "missing":
      return {
        title: "Pairing link incomplete",
        body: "Start a new web pairing from the local assistant and open the full link.",
      };
    case "approved":
      return {
        title: "Connected",
        body: "Opening your assistant.",
      };
    case "expired":
      return {
        title: "Pairing expired",
        body: "Start a new web pairing from the local assistant.",
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
  if (state.kind === "polling") {
    return (
      <LoaderCircle
        className="h-5 w-5 animate-spin text-blue-600"
        aria-hidden
      />
    );
  }
  return <AlertCircle className="h-5 w-5 text-red-600" aria-hidden />;
}

export function RemoteWebPairingPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const enabled = isRemoteGatewayMode();
  const params = useMemo(
    () =>
      parseRemoteWebPairingParams(
        `${location.pathname}${location.search}${location.hash}`,
      ),
    [location.pathname, location.search, location.hash],
  );
  const [state, setState] = useState<PairingState>(
    params.deviceCode
      ? { kind: "polling", expiresAt: null }
      : { kind: "missing" },
  );

  useEffect(() => {
    if (!enabled) return;
    if (!params.deviceCode) {
      setState({ kind: "missing" });
      return;
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const result = await exchangeRemoteWebPairingToken(
          params.deviceCode!,
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
        setState({ kind: "approved" });
        timeout = setTimeout(
          () => navigate(routes.assistant, { replace: true }),
          250,
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof RemoteWebPairingError && err.status === 401) {
          setState({ kind: "expired" });
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
  }, [enabled, params.deviceCode, navigate]);

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

        {params.userCode ? (
          <div className="mb-5 rounded-md border border-[var(--border-subtle)] bg-[var(--background-muted)] p-4 text-center">
            <div className="text-xs font-medium uppercase text-[var(--content-secondary)]">
              Pairing code
            </div>
            <div className="mt-2 font-mono text-3xl font-semibold tracking-[0.18em]">
              {params.userCode}
            </div>
          </div>
        ) : null}

        <p className="text-sm leading-6 text-[var(--content-secondary)]">
          {copy.body}
        </p>

        {state.kind === "polling" && state.expiresAt ? (
          <p className="mt-4 text-xs text-[var(--content-tertiary)]">
            Expires {new Date(state.expiresAt).toLocaleTimeString()}.
          </p>
        ) : null}
      </section>
    </main>
  );
}
