import {
  CalendarPlus,
  ExternalLink,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import type { OAuthConnectPreset } from "@/domains/settings/oauth-scope-presets";
import type { OAuthConnection } from "@/generated/api/types.gen";
import {
  type TenantHostRequirement,
  useTenantHostInput,
} from "@/hooks/use-tenant-host-input";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Tag } from "@vellumai/design-library/components/tag";

export interface ManagedTabProps {
  displayName: string;
  providerKey: string;
  logoUrl: string | null;
  connections: OAuthConnection[];
  connectionsLoading: boolean;
  oauthInProgress: boolean;
  /** Abandon an authorization in progress. */
  onCancelConnect: () => void;
  disconnectingId: string | null;
  /**
   * Pass `requestedScopes` to request a scoped subset; omit for full default.
   * `tenantHost` is the normalized host the user typed, only for per-tenant
   * providers.
   */
  onConnect: (requestedScopes?: string[], tenantHost?: string) => void;
  onDisconnect: (connection: OAuthConnection) => void;
  /** Optional scoped-connect presets (e.g. Google Calendar only). */
  connectPresets?: OAuthConnectPreset[];
  /**
   * Per-tenant providers (Shopify): the host the user must supply before a
   * connect can start, since the provider's OAuth endpoints live on the
   * customer's own domain. Absent for providers with one global host.
   */
  tenantHost?: TenantHostRequirement | null;
}

export function ManagedTab({
  displayName,
  providerKey,
  logoUrl,
  connections,
  connectionsLoading,
  oauthInProgress,
  onCancelConnect,
  disconnectingId,
  onConnect,
  onDisconnect,
  connectPresets = [],
  tenantHost,
}: ManagedTabProps) {
  const { t } = useTranslation("settings");

  // Per-tenant providers need the customer's host before the flow can start;
  // `useTenantHostInput` carries the validation the platform applies.
  const tenantHostInput = useTenantHostInput(tenantHost);
  const connectDisabled = oauthInProgress || !tenantHostInput.valid;
  const startConnect = (requestedScopes?: string[]) =>
    onConnect(requestedScopes, tenantHostInput.normalized);

  const tenantHostField = tenantHost ? (
    <Input
      label={tenantHost.label}
      type="text"
      value={tenantHostInput.value}
      onChange={(e) => tenantHostInput.setValue(e.target.value)}
      placeholder={tenantHost.placeholder}
      aria-invalid={tenantHostInput.showsInvalid || undefined}
      helperText={
        tenantHostInput.showsInvalid
          ? t("managedOauthTab.tenantHostInvalid", {
              label: tenantHost.label,
              placeholder: tenantHost.placeholder,
            })
          : undefined
      }
      disabled={oauthInProgress}
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      fullWidth
    />
  ) : null;

  if (connectionsLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--content-disabled)]" />
      </div>
    );
  }

  if (connections.length === 0) {
    if (oauthInProgress) {
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
            {t("managedOauthTab.waitingForAuthorization")}
            <Button variant="ghost" size="compact" onClick={onCancelConnect}>
              {t("managedOauthTab.cancel")}
            </Button>
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
          {t("managedOauthTab.connectToContinue")}
        </p>
        {tenantHostField && (
          <div className="w-full max-w-sm">{tenantHostField}</div>
        )}
        <div className="flex flex-col items-center gap-2">
          <Button
            variant="primary"
            size="compact"
            leftIcon={<Plus />}
            onClick={() => startConnect()}
            disabled={connectDisabled}
          >
            {t("managedOauthTab.connectAccount")}
          </Button>
          {connectPresets.map((preset) => (
            <Button
              key={preset.id}
              variant="outlined"
              size="compact"
              leftIcon={<CalendarPlus />}
              onClick={() => startConnect(preset.scopes)}
              disabled={connectDisabled}
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
          const accountLabel =
            connection.account_label ??
            t("managedOauthTab.accountFallback", { name: displayName });
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
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <span className="min-w-0 truncate text-body-medium-default text-[var(--content-default)]">
                  {accountLabel}
                </span>
                <Tag tone={connection.connected ? "positive" : "negative"}>
                  {connection.connected
                    ? t("managedOauthTab.statusConnected")
                    : t("managedOauthTab.statusNeedsAttention")}
                </Tag>
              </div>
              <Button
                variant="dangerOutline"
                size="compact"
                iconOnly={
                  isDisconnecting ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )
                }
                onClick={() => onDisconnect(connection)}
                disabled={isDisconnecting}
                aria-label={t("managedOauthTab.disconnectAriaLabel", {
                  account: accountLabel,
                })}
              />
            </li>
          );
        })}
      </ul>
      <div className="border-t border-[var(--border-base)] px-4 py-3 dark:border-[var(--border-base)]">
        {oauthInProgress ? (
          <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("managedOauthTab.waitingForAuthorization")}
            <Button variant="ghost" size="compact" onClick={onCancelConnect}>
              {t("managedOauthTab.cancel")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {tenantHostField && (
              <div className="max-w-sm">{tenantHostField}</div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="compact"
                leftIcon={<ExternalLink />}
                onClick={() => startConnect()}
                disabled={connectDisabled}
              >
                {t("managedOauthTab.connectAccountLower")}
              </Button>
              {connectPresets.map((preset) => (
                <Button
                  key={preset.id}
                  variant="outlined"
                  size="compact"
                  leftIcon={<CalendarPlus />}
                  onClick={() => startConnect(preset.scopes)}
                  disabled={connectDisabled}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
