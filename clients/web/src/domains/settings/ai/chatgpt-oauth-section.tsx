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

import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { t, useTranslation } from "@/i18n";

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
  "idle" | "starting" | "paste_url" | "exchanging" | "completed" | "failed";

interface ChatgptOAuthSectionProps {
  assistantId: string;
  onConnected: (connection: ProviderConnection) => void;
}

export function ChatgptOAuthSection({
  assistantId,
  onConnected,
}: ChatgptOAuthSectionProps) {
  const { t: translate } = useTranslation("settings");
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
      setOauthError(t("settings:chatgptOauthSection.startFailed"));
    }
  }

  async function handleUrlSubmit() {
    setOauthError(null);
    const trimmed = pastedUrl.trim();
    if (!trimmed) {
      setOauthError(t("settings:chatgptOauthSection.pasteUrlError"));
      return;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      setOauthError(t("settings:chatgptOauthSection.invalidUrl"));
      return;
    }
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state");
    if (!code) {
      setOauthError(t("settings:chatgptOauthSection.missingCode"));
      return;
    }
    if (!state) {
      setOauthError(t("settings:chatgptOauthSection.missingState"));
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
      // Unfiltered: the subscription row is found by name, and its provider
      // column differs across daemon versions ("chatgpt" on current daemons,
      // "openai" on older ones), so a provider-filtered list can miss it.
      const { data } = await inferenceProviderconnectionsGet({
        path: { assistant_id: assistantId },
        throwOnError: true,
      });
      const conns = data.connections;
      const chatgptConn = conns.find(
        (c) => c.name === "chatgpt-subscription" || c.name === "openai-chatgpt",
      );
      if (chatgptConn) {
        onConnected(chatgptConn);
      } else {
        onConnected({
          name: "chatgpt-subscription",
          provider: "chatgpt",
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
      setOauthError(t("settings:chatgptOauthSection.completeFailed"));
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
        {translate("chatgptOauthSection.intro")}
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
              {oauthState === "idle"
                ? translate("chatgptOauthSection.step1Idle")
                : translate("chatgptOauthSection.step1PasteUrl")}
            </Typography>
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              {translate("chatgptOauthSection.step2")}
            </Typography>
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              {translate("chatgptOauthSection.step3")}
            </Typography>
          </div>

          {oauthState === "idle" ? (
            <Button
              variant="outlined"
              size="compact"
              onClick={() => void handleSignIn()}
            >
              {translate("chatgptOauthSection.signInButton")}
            </Button>
          ) : (
            <>
              <Input
                value={pastedUrl}
                onChange={(e) => {
                  setPastedUrl(e.target.value);
                  setOauthError(null);
                }}
                placeholder={translate("chatgptOauthSection.urlPlaceholder")}
                fullWidth
              />
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  size="compact"
                  disabled={!pastedUrl.trim()}
                  onClick={() => void handleUrlSubmit()}
                >
                  {translate("chatgptOauthSection.completeSignIn")}
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
            {translate("chatgptOauthSection.startingSignIn")}
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
            {translate("chatgptOauthSection.completingSignIn")}
          </Typography>
        </div>
      ) : null}

      {oauthState === "completed" ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--system-positive-strong)]"
        >
          {translate("chatgptOauthSection.connected")}
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
          {translate("chatgptOauthSection.tryAgain")}
        </Button>
      ) : null}
    </div>
  );
}
