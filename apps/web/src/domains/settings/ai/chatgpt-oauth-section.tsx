import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Typography } from "@vellumai/design-library/components/typography";
import { Loader2 } from "lucide-react";

import {
    inferenceChatgptsubscriptionAuthExchangePost,
    inferenceChatgptsubscriptionAuthPost,
    inferenceProviderconnectionsGet,
} from "@/generated/daemon/sdk.gen";

import type { ProviderConnection } from "@/domains/settings/ai/provider-connections-client";

// ---------------------------------------------------------------------------
// ChatGPT Subscription OAuth Section
// ---------------------------------------------------------------------------
//
// Self-contained OAuth flow for connecting a ChatGPT subscription.
// Renders inside the provider editor modal when auth type is
// "oauth_subscription". Manages a 6-state machine:
//   idle → starting → paste_url → exchanging → completed | failed
//
// On successful exchange the component calls `onConnected` with the
// resulting connection so the parent can persist it.

type ChatgptOAuthState =
  | "idle"
  | "starting"
  | "paste_url"
  | "exchanging"
  | "completed"
  | "failed";

interface ChatgptOAuthSectionProps {
  assistantId: string;
  onConnected: (connection: ProviderConnection) => void;
}

export function ChatgptOAuthSection({
  assistantId,
  onConnected,
}: ChatgptOAuthSectionProps) {
  const [oauthState, setOauthState] = useState<ChatgptOAuthState>("idle");
  const [pastedUrl, setPastedUrl] = useState("");
  const [oauthError, setOauthError] = useState<string | null>(null);

  async function handleSignIn() {
    setOauthState("starting");
    setOauthError(null);
    const popup = window.open("about:blank", "_blank");
    try {
      const {
        data: { authorize_url },
      } = await inferenceChatgptsubscriptionAuthPost({
        path: { assistant_id: assistantId },
        throwOnError: true,
      });
      if (popup) {
        popup.opener = null;
        popup.location.href = authorize_url;
      } else {
        window.open(authorize_url, "_blank", "noopener");
      }
      setOauthState("paste_url");
    } catch {
      popup?.close();
      setOauthState("failed");
      setOauthError("Failed to start ChatGPT sign-in. Please try again.");
    }
  }

  async function handleUrlSubmit() {
    setOauthError(null);
    const trimmed = pastedUrl.trim();
    if (!trimmed) {
      setOauthError("Please paste the URL from the error page.");
      return;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      setOauthError(
        "Invalid URL. Please paste the full URL from the address bar.",
      );
      return;
    }
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state");
    if (!code) {
      setOauthError(
        "The URL is missing the authorization code. Make sure you copied the full URL.",
      );
      return;
    }
    if (!state) {
      setOauthError(
        "The URL is missing the state parameter. Make sure you copied the full URL.",
      );
      return;
    }
    setOauthState("exchanging");
    try {
      await inferenceChatgptsubscriptionAuthExchangePost({
        path: { assistant_id: assistantId },
        body: { code, state },
        throwOnError: true,
      });
      setOauthState("completed");
      const { data } = await inferenceProviderconnectionsGet({
        path: { assistant_id: assistantId },
        query: { provider: "openai" },
        throwOnError: true,
      });
      const conns = data.connections;
      const chatgptConn = conns.find(
        (c) =>
          c.name === "chatgpt-subscription" || c.name === "openai-chatgpt",
      );
      if (chatgptConn) {
        onConnected(chatgptConn);
      } else {
        onConnected({
          name: "chatgpt-subscription",
          provider: "openai",
          auth: {
            type: "oauth_subscription",
            credential: "credential/openai/chatgpt-subscription",
          },
          label: "ChatGPT Subscription",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          baseUrl: null,
          models: null,
          isManaged: false,
        });
      }
    } catch {
      setOauthState("failed");
      setOauthError("Failed to complete sign-in. Please try again.");
    }
  }

  function handleReset() {
    setOauthState("idle");
    setPastedUrl("");
    setOauthError(null);
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border-base)] p-4">
      <Typography
        variant="body-small-default"
        as="p"
        className="text-[var(--content-tertiary)]"
      >
        Connect your ChatGPT subscription to use OpenAI models without an API
        key.
      </Typography>

      {oauthState === "idle" || oauthState === "paste_url" ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Typography
              variant="body-small-default"
              as="p"
              className={
                oauthState === "paste_url"
                  ? "text-[var(--content-tertiary)] line-through"
                  : "text-[var(--content-secondary)]"
              }
            >
              1. Click &ldquo;Sign in with ChatGPT&rdquo;
              {oauthState === "idle" ? " below" : null} to open a popup
            </Typography>
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              2. Sign in, then you&apos;ll land on an error page &mdash;
              that&apos;s expected
            </Typography>
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              3. Copy the full URL from that page&apos;s address bar and paste
              it below
            </Typography>
          </div>

          {oauthState === "idle" ? (
            <Button
              variant="outlined"
              size="compact"
              onClick={() => void handleSignIn()}
            >
              Sign in with ChatGPT
            </Button>
          ) : (
            <>
              <Input
                value={pastedUrl}
                onChange={(e) => {
                  setPastedUrl(e.target.value);
                  setOauthError(null);
                }}
                placeholder="Paste callback URL here..."
                fullWidth
              />
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  size="compact"
                  disabled={!pastedUrl.trim()}
                  onClick={() => void handleUrlSubmit()}
                >
                  Complete Sign In
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {oauthState === "starting" ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
          >
            Starting sign-in...
          </Typography>
        </div>
      ) : null}

      {oauthState === "exchanging" ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
          >
            Completing sign-in...
          </Typography>
        </div>
      ) : null}

      {oauthState === "completed" ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--system-positive-strong)]"
        >
          ChatGPT subscription connected successfully.
        </Typography>
      ) : null}

      {oauthError ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-(--system-negative-strong)"
        >
          {oauthError}
        </Typography>
      ) : null}

      {oauthState === "failed" ? (
        <Button variant="outlined" size="compact" onClick={handleReset}>
          Try Again
        </Button>
      ) : null}
    </div>
  );
}
