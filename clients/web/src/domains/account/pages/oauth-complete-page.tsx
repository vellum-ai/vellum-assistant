import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";

import {
  oauthCompletionStorageKey,
  type OAuthCompletePayload,
} from "@/lib/auth/oauth-popup";

// ── SVG icons ────────────────────────────────────────────────────────────────

function CheckmarkIcon() {
  return (
    <svg
      className="oauth-icon"
      viewBox="0 0 56 56"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="28" cy="28" r="28" fill="var(--oauth-positive-bg)" />
      <path
        className="oauth-check"
        d="M17 28.5L24.5 36L39 21"
        stroke="var(--oauth-positive-fg)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      className="oauth-icon"
      viewBox="0 0 56 56"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="28" cy="28" r="28" fill="var(--oauth-negative-bg)" />
      <path
        className="oauth-cross oauth-cross-1"
        d="M20 20L36 36"
        stroke="var(--oauth-negative-fg)"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        className="oauth-cross oauth-cross-2"
        d="M36 20L20 36"
        stroke="var(--oauth-negative-fg)"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const OAUTH_STYLES = `
  :root {
    --oauth-surface: #F5F3EB;
    --oauth-surface-card: #FFFFFF;
    --oauth-card-border: #E8E6DA;
    --oauth-text-primary: #2A2A28;
    --oauth-text-secondary: #4A4A46;
    --oauth-positive-bg: #D4DFD0;
    --oauth-positive-fg: #516748;
    --oauth-negative-bg: #F7DAC9;
    --oauth-negative-fg: #DA491A;
    --oauth-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06);
    --oauth-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not(.light) {
      --oauth-surface: #1A1A18;
      --oauth-surface-card: #2A2A28;
      --oauth-card-border: #3A3A37;
      --oauth-text-primary: #F5F3EB;
      --oauth-text-secondary: #BDB9A9;
      --oauth-positive-bg: #1A2316;
      --oauth-positive-fg: #7A8B6F;
      --oauth-negative-bg: #4E281D;
      --oauth-negative-fg: #E86B40;
      --oauth-shadow: 0 1px 3px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.3);
    }
  }
  :root[data-theme="dark"] {
    --oauth-surface: #1A1A18;
    --oauth-surface-card: #2A2A28;
    --oauth-card-border: #3A3A37;
    --oauth-text-primary: #F5F3EB;
    --oauth-text-secondary: #BDB9A9;
    --oauth-positive-bg: #1A2316;
    --oauth-positive-fg: #7A8B6F;
    --oauth-negative-bg: #4E281D;
    --oauth-negative-fg: #E86B40;
    --oauth-shadow: 0 1px 3px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.3);
  }
  .oauth-page {
    font-family: var(--oauth-font);
    background: var(--oauth-surface);
    color: var(--oauth-text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
    padding: 0;
    -webkit-font-smoothing: antialiased;
  }
  .oauth-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 48px 40px 40px;
    background: var(--oauth-surface-card);
    border: 1px solid var(--oauth-card-border);
    border-radius: 16px;
    box-shadow: var(--oauth-shadow);
    max-width: 380px;
    width: 100%;
    opacity: 0;
    transform: translateY(8px) scale(0.98);
    animation: oauthCardIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.1s forwards;
  }
  @keyframes oauthCardIn {
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .oauth-icon {
    width: 56px;
    height: 56px;
    margin-bottom: 20px;
    flex-shrink: 0;
  }
  .oauth-check {
    stroke-dasharray: 32;
    stroke-dashoffset: 32;
    animation: oauthDraw 0.4s ease-out 0.45s forwards;
  }
  .oauth-cross {
    stroke-dasharray: 22;
    stroke-dashoffset: 22;
  }
  .oauth-cross-1 { animation: oauthDraw 0.3s ease-out 0.45s forwards; }
  .oauth-cross-2 { animation: oauthDraw 0.3s ease-out 0.55s forwards; }
  @keyframes oauthDraw {
    to { stroke-dashoffset: 0; }
  }
  .oauth-card h1 {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.2px;
    color: var(--oauth-text-primary);
    margin: 0 0 6px;
  }
  .oauth-card p {
    font-size: 13px;
    line-height: 1.5;
    color: var(--oauth-text-secondary);
    margin: 0;
  }
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatProviderName(provider: string): string {
  return provider
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface OAuthCompleteTarget {
  opener: { postMessage(message: unknown, targetOrigin: string): void } | null;
  origin: string;
  storage: Pick<Storage, "setItem">;
  close: () => void;
}

export function completeOAuthPopup(
  payload: OAuthCompletePayload,
  target: OAuthCompleteTarget,
): void {
  if (target.opener) {
    target.opener.postMessage(payload, target.origin);
  }

  if (payload.requestId) {
    try {
      target.storage.setItem(
        oauthCompletionStorageKey(payload.requestId),
        JSON.stringify(payload),
      );
    } catch {
      // Best-effort fallback for popup contexts where window.opener is lost.
    }
  }

  target.close();
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function OAuthCompletePage() {
  const [searchParams] = useSearchParams();
  const requestId = searchParams.get("requestId");
  const oauthStatus = searchParams.get("oauth_status");
  const oauthProvider = searchParams.get("oauth_provider");
  const oauthCode = searchParams.get("oauth_code");

  const displayProvider = oauthProvider
    ? formatProviderName(oauthProvider)
    : "";

  const isSuccess = oauthStatus === "connected";

  const title = isSuccess
    ? displayProvider
      ? `Connected to ${displayProvider}`
      : "Authorization Successful"
    : "Authorization Failed";

  const subtitle = isSuccess
    ? "You can close this tab and return to your assistant."
    : `${displayProvider || "Service"} connection failed. You can try again from the desktop app.`;

  const completionSent = useRef(false);

  useEffect(() => {
    if (completionSent.current) return;
    completionSent.current = true;

    const payload: OAuthCompletePayload = {
      type: "vellum:oauth-complete",
      requestId,
      oauthStatus: oauthStatus || null,
      oauthProvider: oauthProvider || null,
      oauthCode: oauthCode || null,
    };

    completeOAuthPopup(payload, {
      opener: window.opener,
      origin: window.location.origin,
      storage: window.localStorage,
      close: () => window.close(),
    });
  }, [requestId, oauthStatus, oauthProvider, oauthCode]);

  return (
    <div className="oauth-page">
      <style dangerouslySetInnerHTML={{ __html: OAUTH_STYLES }} />
      <div className="oauth-card">
        {isSuccess ? <CheckmarkIcon /> : <ErrorIcon />}
        <h1>{title}</h1>
        <p>{subtitle}</p>
        {!isSuccess && oauthCode && (
          <p style={{ marginTop: 8, fontSize: 11, color: "var(--oauth-text-secondary)", opacity: 0.7 }}>
            Error: {oauthCode}
          </p>
        )}
      </div>
    </div>
  );
}
