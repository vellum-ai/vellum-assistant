import { CalendarPlus, ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import type { OAuthConnectPreset } from "@/domains/settings/oauth-scope-presets";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { Button } from "@vellumai/design-library/components/button";

export interface ManagedTabProps {
  displayName: string;
  providerKey: string;
  logoUrl: string | null;
  connections: OAuthConnection[];
  connectionsLoading: boolean;
  startPending: boolean;
  oauthInProgress: boolean;
  disconnectingId: string | null;
  /** Pass `requestedScopes` to request a scoped subset; omit for full default. */
  onConnect: (requestedScopes?: string[]) => void;
  onDisconnect: (connection: OAuthConnection) => void;
  /** Optional scoped-connect presets (e.g. Google Calendar only). */
  connectPresets?: OAuthConnectPreset[];
}

export function ManagedTab({
  displayName,
  providerKey,
  logoUrl,
  connections,
  connectionsLoading,
  startPending,
  oauthInProgress,
  disconnectingId,
  onConnect,
  onDisconnect,
  connectPresets = [],
}: ManagedTabProps) {
  const connectBusy = startPending || oauthInProgress;
  if (connectionsLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--content-disabled)]" />
      </div>
    );
  }

  if (connections.length === 0) {
    if (startPending || oauthInProgress) {
      return (
        <div className="flex flex-col items-center gap-3 py-10">
          <IntegrationIcon
            providerKey={providerKey}
            displayName={displayName}
            logoUrl={logoUrl}
            size={48}
          />
          <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Waiting for authorization...
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <IntegrationIcon
          providerKey={providerKey}
          displayName={displayName}
          logoUrl={logoUrl}
          size={48}
        />
        <p className="text-body-medium-default text-[var(--content-secondary)]">
          Connect Account to continue
        </p>
        <div className="flex flex-col items-center gap-2">
          <Button
            variant="primary"
            size="compact"
            leftIcon={<Plus />}
            onClick={() => onConnect()}
            disabled={connectBusy}
          >
            Connect Account
          </Button>
          {connectPresets.map((preset) => (
            <Button
              key={preset.id}
              variant="outlined"
              size="compact"
              leftIcon={<CalendarPlus />}
              onClick={() => onConnect(preset.scopes)}
              disabled={connectBusy}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border-base)]">
      <ul className="divide-y divide-[var(--border-base)]">
        {connections.map((connection) => {
          const isDisconnecting = disconnectingId === connection.id;
          return (
            <li
              key={connection.id}
              className="flex items-center gap-3 px-4 py-3"
            >
              <IntegrationIcon
                providerKey={providerKey}
                displayName={displayName}
                logoUrl={logoUrl}
                size={20}
              />
              <span className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-default)]">
                {connection.account_label ?? `${displayName} Account`}
              </span>
              <Button
                variant="dangerOutline"
                size="compact"
                iconOnly={isDisconnecting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                onClick={() => onDisconnect(connection)}
                disabled={isDisconnecting}
                aria-label={`Disconnect ${connection.account_label ?? `${displayName} account`}`}
              />
            </li>
          );
        })}
      </ul>
      <div className="border-t border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
        {connectBusy ? (
          <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Waiting for authorization...
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="compact"
              leftIcon={<ExternalLink />}
              onClick={() => onConnect()}
              disabled={connectBusy}
            >
              Connect account
            </Button>
            {connectPresets.map((preset) => (
              <Button
                key={preset.id}
                variant="outlined"
                size="compact"
                leftIcon={<CalendarPlus />}
                onClick={() => onConnect(preset.scopes)}
                disabled={connectBusy}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
