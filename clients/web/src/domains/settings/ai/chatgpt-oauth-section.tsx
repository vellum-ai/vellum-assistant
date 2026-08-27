import { useCallback, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { useTranslation } from "@/i18n";

import { ChatgptDeviceAuthFlow } from "./chatgpt-device-auth-flow";
import { ChatgptPasteAuthFlow } from "./chatgpt-paste-auth-flow";

interface ChatgptOAuthSectionProps {
  assistantId: string;
  onConnected: (connection: ProviderConnection) => void;
}

/**
 * Connects a ChatGPT subscription. Rendered inside the provider editor when
 * the auth type is `oauth_subscription`.
 *
 * Device code leads: it asks the user for nothing but a code typed into
 * ChatGPT's own page. The redirect-and-paste flow stays reachable behind a
 * disclosure, because device code authorization is an account setting an
 * organization can switch off, and it takes the section over outright when the
 * assistant's daemon has no device-auth route at all. Either path reports the
 * same stored connection through `onConnected` for the parent to persist.
 */
export function ChatgptOAuthSection({
  assistantId,
  onConnected,
}: ChatgptOAuthSectionProps) {
  const { t } = useTranslation("settings");
  const [otherOptionsOpen, setOtherOptionsOpen] = useState(false);
  const [deviceAuthUnsupported, setDeviceAuthUnsupported] = useState(false);
  const handleDeviceAuthUnsupported = useCallback(
    () => setDeviceAuthUnsupported(true),
    [],
  );

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border-base)] p-4">
      <Typography
        variant="body-small-default"
        as="p"
        className="text-[var(--content-tertiary)]"
      >
        {t("chatgptOauthSection.intro")}
      </Typography>

      {deviceAuthUnsupported ? null : (
        <>
          <ChatgptDeviceAuthFlow
            assistantId={assistantId}
            onConnected={onConnected}
            superseded={otherOptionsOpen}
            onUnsupported={handleDeviceAuthUnsupported}
          />

          <div>
            <Button
              variant="ghost"
              size="compact"
              aria-expanded={otherOptionsOpen}
              onClick={() => setOtherOptionsOpen((open) => !open)}
            >
              {otherOptionsOpen
                ? t("chatgptOauthSection.hideOtherOptions")
                : t("chatgptOauthSection.otherOptions")}
            </Button>
          </div>
        </>
      )}

      {otherOptionsOpen || deviceAuthUnsupported ? (
        <ChatgptPasteAuthFlow
          assistantId={assistantId}
          onConnected={onConnected}
        />
      ) : null}
    </div>
  );
}
