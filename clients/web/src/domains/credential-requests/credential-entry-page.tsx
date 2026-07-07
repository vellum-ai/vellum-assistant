import { AlertCircle, CheckCircle2, KeyRound, LoaderCircle } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Input } from "@vellumai/design-library/components/input";

import {
  credentialExpiryToEpochMs,
  peekCredentialRequest,
  submitCredentialRequest,
  type CredentialRequestDetails,
} from "./credential-entry-api";

/**
 * Public one-time credential entry page (`/assistant/credentials/enter`).
 *
 * Opened from a single-use credential-request link. The person opening it
 * may have no Vellum session at all, so — like the remote-web pairing page —
 * this page must not import anything that assumes auth state (no assistant
 * stores, no gateway session helpers beyond the path-prefix util). The
 * single-use token from `?token=` is held in memory, stripped from the URL
 * immediately, and sent only in POST bodies.
 */

type Phase =
  | { kind: "loading" }
  | { kind: "form"; request: CredentialRequestDetails }
  | { kind: "success" }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "used" }
  | { kind: "error" };

/** Re-renders every `intervalMs` so the expiry countdown ticks. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function StatusCard({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <>
      <div className="flex items-center gap-3">
        {icon}
        <h1 className="text-xl font-semibold">{title}</h1>
      </div>
      <p className="text-sm leading-6 text-[var(--content-secondary)]">
        {children}
      </p>
    </>
  );
}

export function CredentialEntryPage() {
  // The token is captured once, before it is stripped from the URL below.
  const [token] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("token")?.trim() || null;
  });
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const now = useNow(1000);

  // Strip the token from the address bar and history entry immediately so it
  // can't leak via a copied URL, browser history sync, or a screenshot.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("token")) {
      return;
    }
    url.searchParams.delete("token");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);

  // Peek the request on mount to learn what secret is being asked for.
  useEffect(() => {
    if (!token) {
      setPhase({ kind: "invalid" });
      return;
    }

    const controller = new AbortController();

    const peek = async () => {
      const result = await peekCredentialRequest(token, controller.signal).catch(
        () => ({ status: "error" }) as const,
      );
      if (controller.signal.aborted) {
        return;
      }
      if (result.status === "ok") {
        setPhase({ kind: "form", request: result.request });
      } else {
        setPhase({ kind: result.status });
      }
    };

    void peek();

    return () => {
      controller.abort();
    };
  }, [token]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!token || phase.kind !== "form" || !trimmed || submitting) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const result = await submitCredentialRequest(token, trimmed).catch(
      () => ({ status: "error" }) as const,
    );
    setSubmitting(false);
    switch (result.status) {
      case "ok":
        setValue("");
        setPhase({ kind: "success" });
        break;
      case "invalid":
      case "expired":
      case "used":
        setPhase({ kind: result.status });
        break;
      case "store-failed":
        setSubmitError(
          "The assistant couldn't store the credential. Your value was not saved — try again.",
        );
        break;
      case "error":
        setSubmitError(
          "Something went wrong while submitting. Check your connection and try again.",
        );
        break;
    }
  };

  const expiresAtMs =
    phase.kind === "form"
      ? credentialExpiryToEpochMs(phase.request.expiresAt)
      : null;
  const hasLiveForm =
    phase.kind === "form" && expiresAtMs !== null && expiresAtMs > now;

  let content: ReactNode;
  if (phase.kind === "loading") {
    content = (
      <StatusCard
        icon={
          <LoaderCircle
            className="h-5 w-5 animate-spin text-blue-600"
            aria-hidden
          />
        }
        title="Checking link"
      >
        Looking up this credential request.
      </StatusCard>
    );
  } else if (phase.kind === "success") {
    content = (
      <StatusCard
        icon={<CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden />}
        title="Credential saved"
      >
        You can close this tab and return to your conversation — the assistant
        can use the credential right away. The value can't be viewed again.
      </StatusCard>
    );
  } else if (phase.kind === "invalid") {
    content = (
      <StatusCard
        icon={<AlertCircle className="h-5 w-5 text-red-600" aria-hidden />}
        title="Link not valid"
      >
        This credential link isn't valid. Check that the full link was copied,
        or ask for a new one.
      </StatusCard>
    );
  } else if (phase.kind === "expired" || (phase.kind === "form" && !hasLiveForm)) {
    content = (
      <StatusCard
        icon={<AlertCircle className="h-5 w-5 text-red-600" aria-hidden />}
        title="Link expired"
      >
        This credential link has expired. Links only work for a short time —
        ask for a new one and enter the value again.
      </StatusCard>
    );
  } else if (phase.kind === "used") {
    content = (
      <StatusCard
        icon={<AlertCircle className="h-5 w-5 text-red-600" aria-hidden />}
        title="Link already used"
      >
        This credential link has already been used. Each link works exactly
        once — ask for a new one if the value still needs to be provided.
      </StatusCard>
    );
  } else if (phase.kind === "error") {
    content = (
      <StatusCard
        icon={<AlertCircle className="h-5 w-5 text-red-600" aria-hidden />}
        title="Something went wrong"
      >
        The credential request couldn't be loaded. Refresh the page to try
        again.
      </StatusCard>
    );
  } else {
    const { request } = phase;
    const name = `${request.service}:${request.field}`;
    const remainingMs = (expiresAtMs ?? 0) - now;
    content = (
      <>
        <div className="flex items-center gap-3">
          <KeyRound className="h-5 w-5 text-blue-600" aria-hidden />
          <h1 className="text-xl font-semibold">Provide a credential</h1>
        </div>

        <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--background-muted)] p-4">
          <p className="text-body-medium-default text-[var(--content-default)]">
            {request.label || name}
          </p>
          <p className="mt-1 font-mono text-body-small-default text-[var(--content-tertiary)]">
            {request.label ? `${name} · ` : ""}one-time entry
          </p>
        </div>

        <p className="text-sm leading-6 text-[var(--content-secondary)]">
          Enter the secret value below. It is stored encrypted on the
          assistant, is never shown again, and this link stops working as soon
          as it's used.
        </p>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <Input
            label="Secret value"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Enter the secret value"
            autoComplete="off"
            autoFocus
            fullWidth
            errorText={submitError ?? undefined}
          />
          <Button
            type="submit"
            disabled={submitting || !value.trim()}
            leftIcon={
              submitting ? (
                <LoaderCircle className="animate-spin" aria-hidden />
              ) : undefined
            }
          >
            Submit
          </Button>
        </form>

        <p className="text-xs text-[var(--content-tertiary)]">
          Expires in {formatRemaining(remainingMs)} (
          {new Date(expiresAtMs ?? 0).toLocaleTimeString()}).
        </p>
      </>
    );
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-[var(--background-default)] px-6 py-10 text-[var(--content-primary)]">
      <div className="w-full max-w-md">
        <Card.Root bordered elevated padding="lg">
          <div className="flex flex-col gap-4">{content}</div>
        </Card.Root>
      </div>
    </main>
  );
}
