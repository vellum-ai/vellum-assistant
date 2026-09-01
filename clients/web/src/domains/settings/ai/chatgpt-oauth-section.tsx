import { useCallback, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import { inferenceProviderconnectionsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { useTranslation } from "@/i18n";

import { ChatgptDefaultProviderStep } from "./chatgpt-default-provider-step";
import { ChatgptDeviceAuthFlow } from "./chatgpt-device-auth-flow";
import { ChatgptPasteAuthFlow } from "./chatgpt-paste-auth-flow";
import { useChatgptDeviceCodeLogin } from "./use-chatgpt-device-code-login-flag";

interface ChatgptOAuthSectionProps {
  assistantId: string;
  onConnected: (connection: ProviderConnection) => void;
}

/** Which sign-in stored the credential, so the other one steps aside. */
type SignInPath = "device" | "paste";

interface ConnectedSignIn {
  connection: ProviderConnection;
  via: SignInPath;
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
 * code joined it.
 *
 * Both paths finish here: whichever one stored the credential hands its
 * connection to the default-provider step, and the host is told about it
 * (which closes the editor) once that step is done with it.
 */
export function ChatgptOAuthSection({
  assistantId,
  onConnected,
}: ChatgptOAuthSectionProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
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
  const [connected, setConnected] = useState<ConnectedSignIn | null>(null);
  const handleDeviceAuthUnsupported = useCallback(
    () => setDeviceAuthUnsupported(true),
    [],
  );
  const deviceCodeShown = deviceCodeLoginOn && !deviceAuthUnsupported;

  const handleConnected = useCallback(
    (connection: ProviderConnection, via: SignInPath) => {
      setConnected({ connection, via });
      // The row exists on the daemon now, so the Providers list behind the
      // editor is stale whether or not the user finishes the step below.
      void queryClient.invalidateQueries({
        queryKey: inferenceProviderconnectionsGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
    },
    [assistantId, queryClient],
  );
  const handleDeviceConnected = useCallback(
    (connection: ProviderConnection) => handleConnected(connection, "device"),
    [handleConnected],
  );
  const handlePasteConnected = useCallback(
    (connection: ProviderConnection) => handleConnected(connection, "paste"),
    [handleConnected],
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

      {deviceCodeShown && connected?.via !== "paste" ? (
        <>
          <ChatgptDeviceAuthFlow
            assistantId={assistantId}
            onConnected={handleDeviceConnected}
            superseded={otherOptionsOpen}
            onUnsupported={handleDeviceAuthUnsupported}
          />

          {connected ? null : (
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
          )}
        </>
      ) : null}

      {(!deviceCodeShown || otherOptionsOpen) && connected?.via !== "device" ? (
        <ChatgptPasteAuthFlow
          assistantId={assistantId}
          onConnected={handlePasteConnected}
          standalone={!deviceCodeShown}
        />
      ) : null}

      {connected ? (
        <ChatgptDefaultProviderStep
          assistantId={assistantId}
          connection={connected.connection}
          onDone={onConnected}
        />
      ) : null}
    </div>
  );
}
