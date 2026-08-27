import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Typography } from "@vellumai/design-library/components/typography";
import { Loader2 } from "lucide-react";

import {
  inferenceChatgptsubscriptionAuthExchangePost,
  inferenceChatgptsubscriptionAuthPost,
} from "@/generated/daemon/sdk.gen";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { t, useTranslation } from "@/i18n";

import { resolveChatgptConnection } from "./chatgpt-subscription-api";

/**
 * The redirect-and-paste sign-in for a ChatGPT subscription: open OpenAI's
 * authorize page in a second tab, then hand the daemon the `code` and `state`
 * off the callback URL the user copies back.
 *
 * Serves as the section's only sign-in, and as the fallback behind the
 * device-code flow, which needs nothing pasted but depends on an account
 * setting some organizations switch off. Only the copy differs between the
 * two: see {@link ChatgptPasteAuthFlowProps.standalone}.
 */
type ChatgptPasteAuthState =
  | "idle"
  | "starting"
  | "paste_url"
  | "exchanging"
  | "completed"
  | "failed";

interface ChatgptPasteAuthFlowProps {
  assistantId: string;
  onConnected: (connection: ProviderConnection) => void;
  /**
   * Whether this flow is the section's only sign-in rather than the fallback
   * offered beside the device code. Alone it is simply "Sign in with ChatGPT";
   * beside the device code that name would claim the whole section, so it
   * narrows to the tab it opens.
   */
  standalone?: boolean;
}

export function ChatgptPasteAuthFlow({
  assistantId,
  onConnected,
  standalone = false,
}: ChatgptPasteAuthFlowProps) {
  const { t: translate } = useTranslation("settings");
  const [authState, setAuthState] = useState<ChatgptPasteAuthState>("idle");
  const [pastedUrl, setPastedUrl] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  async function handleSignIn() {
    setAuthState("starting");
    setAuthError(null);
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
      setAuthState("paste_url");
    } catch {
      popup?.close();
      setAuthState("failed");
      setAuthError(t("settings:chatgptPasteAuthFlow.startFailed"));
    }
  }

  async function handleUrlSubmit() {
    setAuthError(null);
    const trimmed = pastedUrl.trim();
    if (!trimmed) {
      setAuthError(t("settings:chatgptPasteAuthFlow.pasteUrlError"));
      return;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      setAuthError(t("settings:chatgptPasteAuthFlow.invalidUrl"));
      return;
    }
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state");
    if (!code) {
      setAuthError(t("settings:chatgptPasteAuthFlow.missingCode"));
      return;
    }
    if (!state) {
      setAuthError(t("settings:chatgptPasteAuthFlow.missingState"));
      return;
    }
    setAuthState("exchanging");
    try {
      await inferenceChatgptsubscriptionAuthExchangePost({
        path: { assistant_id: assistantId },
        body: { code, state },
        throwOnError: true,
      });
      setAuthState("completed");
      onConnected(await resolveChatgptConnection(assistantId));
    } catch {
      setAuthState("failed");
      setAuthError(t("settings:chatgptPasteAuthFlow.completeFailed"));
    }
  }

  function handleReset() {
    setAuthState("idle");
    setPastedUrl("");
    setAuthError(null);
  }

  return (
    <div className="space-y-3">
      {authState === "idle" || authState === "paste_url" ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Typography
              variant="body-small-default"
              as="p"
              className={
                authState === "paste_url"
                  ? "text-[var(--content-tertiary)] line-through"
                  : "text-[var(--content-secondary)]"
              }
            >
              {authState === "idle"
                ? translate(
                    standalone
                      ? "chatgptPasteAuthFlow.step1IdleStandalone"
                      : "chatgptPasteAuthFlow.step1Idle",
                  )
                : translate(
                    standalone
                      ? "chatgptPasteAuthFlow.step1PasteUrlStandalone"
                      : "chatgptPasteAuthFlow.step1PasteUrl",
                  )}
            </Typography>
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              {translate("chatgptPasteAuthFlow.step2")}
            </Typography>
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-secondary)]"
            >
              {translate("chatgptPasteAuthFlow.step3")}
            </Typography>
          </div>

          {authState === "idle" ? (
            <Button
              variant="outlined"
              size="compact"
              onClick={() => void handleSignIn()}
            >
              {translate(
                standalone
                  ? "chatgptPasteAuthFlow.signInButtonStandalone"
                  : "chatgptPasteAuthFlow.signInButton",
              )}
            </Button>
          ) : (
            <>
              <Input
                value={pastedUrl}
                onChange={(e) => {
                  setPastedUrl(e.target.value);
                  setAuthError(null);
                }}
                placeholder={translate("chatgptPasteAuthFlow.urlPlaceholder")}
                fullWidth
              />
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  size="compact"
                  disabled={!pastedUrl.trim()}
                  onClick={() => void handleUrlSubmit()}
                >
                  {translate("chatgptPasteAuthFlow.completeSignIn")}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {authState === "starting" ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
          >
            {translate("chatgptPasteAuthFlow.startingSignIn")}
          </Typography>
        </div>
      ) : null}

      {authState === "exchanging" ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
          >
            {translate("chatgptPasteAuthFlow.completingSignIn")}
          </Typography>
        </div>
      ) : null}

      {authState === "completed" ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--system-positive-strong)]"
        >
          {translate("chatgptPasteAuthFlow.connected")}
        </Typography>
      ) : null}

      {authError ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-(--system-negative-strong)"
        >
          {authError}
        </Typography>
      ) : null}

      {authState === "failed" ? (
        <Button variant="outlined" size="compact" onClick={handleReset}>
          {translate("chatgptPasteAuthFlow.tryAgain")}
        </Button>
      ) : null}
    </div>
  );
}
