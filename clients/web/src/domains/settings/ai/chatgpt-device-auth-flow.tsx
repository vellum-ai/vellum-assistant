import { type PropsWithChildren, useEffect } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";
import { Check, Copy, Loader2 } from "lucide-react";

import { ExternalAnchor } from "@/components/external-anchor";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Trans, useTranslation } from "@/i18n";

import { useChatgptDeviceAuth } from "./use-chatgpt-device-auth";

/** Where the account owner switches device code authorization on. */
const CHATGPT_SECURITY_SETTINGS_URL = "https://chatgpt.com/security-settings";

interface ChatgptDeviceAuthFlowProps {
  assistantId: string;
  onConnected: (connection: ProviderConnection) => void;
  /** Another sign-in path has taken over, so a live code is dropped. */
  superseded?: boolean;
  /** The daemon has no device-auth route, so this path cannot be offered. */
  onUnsupported?: () => void;
}

/** The security-settings destination named inside the stalled-flow hint. */
function ChatgptSettingsLink({ children }: PropsWithChildren) {
  return (
    <ExternalAnchor
      href={CHATGPT_SECURITY_SETTINGS_URL}
      className="underline hover:opacity-80"
    >
      {children}
    </ExternalAnchor>
  );
}

/**
 * Device-code sign-in for a ChatGPT subscription: the assistant shows a code,
 * the user types it into ChatGPT's own page, and the credential lands without
 * anything being pasted back.
 *
 * The code stays on screen through a rejection, because the usual cause is an
 * account with device code authorization switched off and the same code works
 * once that is on.
 */
export function ChatgptDeviceAuthFlow({
  assistantId,
  onConnected,
  superseded = false,
  onUnsupported,
}: ChatgptDeviceAuthFlowProps) {
  const { t } = useTranslation("settings");
  const auth = useChatgptDeviceAuth({ assistantId, onConnected });
  const { copy, copied } = useCopyToClipboard({
    errorMessage: t("chatgptDeviceAuthFlow.copyError"),
  });

  // Two sign-ins at once would leave whichever the user abandons polling, so
  // the code goes when the other path opens. A finished sign-in stays put.
  const { reset } = auth;
  const dropLiveCode =
    superseded && auth.phase !== "idle" && auth.phase !== "connected";
  useEffect(() => {
    if (dropLiveCode) {
      reset();
    }
  }, [dropLiveCode, reset]);

  // An assistant whose daemon predates these routes has only the paste flow,
  // so the section is told to show that one in place of this.
  const { unsupported } = auth;
  useEffect(() => {
    if (unsupported) {
      onUnsupported?.();
    }
  }, [unsupported, onUnsupported]);

  if (auth.phase === "connected") {
    return (
      <Typography
        variant="body-small-default"
        as="p"
        className="text-[var(--system-positive-strong)]"
      >
        {t("chatgptDeviceAuthFlow.connected")}
      </Typography>
    );
  }

  if (auth.phase === "idle") {
    return (
      <Button
        variant="primary"
        size="compact"
        onClick={() => void auth.start()}
      >
        {t("chatgptDeviceAuthFlow.signInButton")}
      </Button>
    );
  }

  if (auth.phase === "starting") {
    return (
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
        <Typography
          variant="body-small-default"
          className="text-[var(--content-tertiary)]"
        >
          {t("chatgptDeviceAuthFlow.starting")}
        </Typography>
      </div>
    );
  }

  const { code } = auth;

  return (
    <div className="space-y-3">
      {code ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-md bg-[var(--surface-active)] px-3 py-2 text-title-medium tracking-[0.2em] text-[color:var(--content-emphasised)]">
              {code.userCode}
            </code>
            <Button
              variant="outlined"
              size="compact"
              leftIcon={copied ? <Check /> : <Copy />}
              onClick={() => copy(code.userCode)}
            >
              {copied
                ? t("chatgptDeviceAuthFlow.copiedButton")
                : t("chatgptDeviceAuthFlow.copyButton")}
            </Button>
          </div>
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-secondary)]"
          >
            {t("chatgptDeviceAuthFlow.instructions")}
          </Typography>
          <Button asChild variant="primary" size="compact">
            <ExternalAnchor href={code.verificationUrl}>
              {t("chatgptDeviceAuthFlow.openButton")}
            </ExternalAnchor>
          </Button>
        </div>
      ) : null}

      {auth.phase === "awaiting_authorization" ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
          >
            {t("chatgptDeviceAuthFlow.waiting")}
          </Typography>
        </div>
      ) : null}

      {auth.error ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-(--system-negative-strong)"
        >
          {auth.error}
        </Typography>
      ) : null}

      {auth.showAuthorizationHint ? (
        <Notice tone="warning">
          <Trans
            ns="settings"
            i18nKey="chatgptDeviceAuthFlow.authorizationHint"
            components={{ settingsLink: <ChatgptSettingsLink /> }}
          />
        </Notice>
      ) : null}

      {auth.phase === "error" && code === null ? (
        <Button
          variant="outlined"
          size="compact"
          onClick={() => void auth.start()}
        >
          {t("chatgptDeviceAuthFlow.tryAgain")}
        </Button>
      ) : null}

      {code ? (
        <Button variant="ghost" size="compact" onClick={auth.reset}>
          {t("chatgptDeviceAuthFlow.startOver")}
        </Button>
      ) : null}
    </div>
  );
}
