import { useCallback, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { useTranslation } from "@/i18n";

import { ChatgptDeviceAuthFlow } from "./chatgpt-device-auth-flow";
import { ChatgptPasteAuthFlow } from "./chatgpt-paste-auth-flow";
import { useChatgptDeviceCodeLogin } from "./use-chatgpt-device-code-login-flag";

interface ChatgptOAuthSectionProps {
  assistantId: string;
  onConnected: (connection: ProviderConnection) => void;
}

/**
 * Connects a ChatGPT subscription. Rendered inside the provider editor when
 * the auth type is `oauth_subscription`.
 *
 * The redirect-and-paste flow is the whole section unless
 * `chatgpt-device-code-login` is on. Under that flag the device code leads,
 * asking the user for nothing but a code typed into ChatGPT's own page, and
 * redirect-and-paste stays reachable behind a disclosure: device code
 * authorization is an account setting an organization can switch off, and the
 * paste flow takes the section over outright when the assistant's daemon has
 * no device-auth route at all. Whenever the paste flow is the only sign-in on
 * screen it stands alone, under the plain name it carried before the device
 * code joined it. Every path reports the same stored connection through
 * `onConnected` for the parent to persist.
 */
export function ChatgptOAuthSection({
  assistantId,
  onConnected,
}: ChatgptOAuthSectionProps) {
  const { t } = useTranslation("settings");
  const deviceCodeLoginFlag = useChatgptDeviceCodeLogin();
  // The flag picks the section's shape once, at mount, and a value that lands
  // afterwards never changes it. Swapping the flows mid-visit would unmount
  // whichever one the user had already started: a pending PKCE exchange and a
  // pasted callback URL would go with it, stranding the authorization page
  // they had opened. A mount that reads the pre-hydration default keeps the
  // redirect-and-paste flow, which signs in on its own, and the next time the
  // editor opens the settled value leads.
  const [deviceCodeLoginOn] = useState(deviceCodeLoginFlag);
  const [otherOptionsOpen, setOtherOptionsOpen] = useState(false);
  const [deviceAuthUnsupported, setDeviceAuthUnsupported] = useState(false);
  const handleDeviceAuthUnsupported = useCallback(
    () => setDeviceAuthUnsupported(true),
    [],
  );
  const deviceCodeShown = deviceCodeLoginOn && !deviceAuthUnsupported;

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border-base)] p-4">
      <Typography
        variant="body-small-default"
        as="p"
        className="text-[var(--content-tertiary)]"
      >
        {t("chatgptOauthSection.intro")}
      </Typography>

      {deviceCodeShown ? (
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
      ) : null}

      {!deviceCodeShown || otherOptionsOpen ? (
        <ChatgptPasteAuthFlow
          assistantId={assistantId}
          onConnected={onConnected}
          standalone={!deviceCodeShown}
        />
      ) : null}
    </div>
  );
}
