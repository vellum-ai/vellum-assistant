import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import {
  defaultManagedOAuthConnectClient,
  type ManagedOAuthConnectClient,
  type ManagedOAuthProviderSummary,
} from "@/domains/chat/api/managed-oauth";
import type { Surface } from "@/domains/chat/types/types";

interface OAuthConnectSurfaceData {
  providerKey?: string;
  displayName?: string;
  description?: string;
  logoUrl?: string | null;
  requestedScopes?: string[];
  connectLabel?: string;
}

interface OAuthConnectSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  assistantId?: string | null;
  oauthClient?: ManagedOAuthConnectClient;
}

type ConnectState = "idle" | "connecting" | "connected" | "error";

function titleizeProviderKey(providerKey: string): string {
  return providerKey
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getProviderLabel(
  data: OAuthConnectSurfaceData,
  provider: ManagedOAuthProviderSummary | null,
): string {
  if (data.displayName) return data.displayName;
  if (provider?.display_name) return provider.display_name;
  if (data.providerKey) return titleizeProviderKey(data.providerKey);
  return "this account";
}

export function OAuthConnectSurface({
  surface,
  onAction,
  assistantId,
  oauthClient = defaultManagedOAuthConnectClient,
}: OAuthConnectSurfaceProps) {
  const data = surface.data as OAuthConnectSurfaceData;
  const providerKey = data.providerKey ?? "";
  const [provider, setProvider] = useState<ManagedOAuthProviderSummary | null>(
    null,
  );
  const [state, setState] = useState<ConnectState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!assistantId || !providerKey) return;
    void oauthClient.fetchProvider(assistantId, providerKey).then((result) => {
      if (!cancelled) {
        setProvider(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [assistantId, oauthClient, providerKey]);

  const providerLabel = getProviderLabel(data, provider);
  const logoUrl = data.logoUrl ?? provider?.logo_url ?? null;
  const description =
    data.description ??
    provider?.description ??
    `Connect ${providerLabel} so I can use it for this task.`;
  const connectLabel = data.connectLabel ?? `Connect ${providerLabel}`;
  const scopes = useMemo(
    () =>
      Array.isArray(data.requestedScopes)
        ? data.requestedScopes.filter((scope) => typeof scope === "string")
        : [],
    [data.requestedScopes],
  );

  const submitCancel = () => {
    onAction(surface.surfaceId, "cancel", {
      status: "cancelled",
      providerKey,
      providerLabel,
    });
  };

  const handleConnect = async () => {
    if (!assistantId || !providerKey || state === "connecting") return;
    setState("connecting");
    setErrorMessage(null);

    const result = await oauthClient.connect({
      assistantId,
      providerKey,
      providerLabel,
      requestedScopes: scopes,
    });

    if (result.status === "connected") {
      setState("connected");
      onAction(surface.surfaceId, "connect", {
        status: "connected",
        providerKey,
        providerLabel,
        connectionId: result.connection?.id,
        accountLabel: result.connection?.account_label,
        scopesGranted: result.connection?.scopes_granted ?? [],
      });
      return;
    }

    if (result.status === "cancelled") {
      onAction(surface.surfaceId, "cancel", {
        status: "cancelled",
        providerKey,
        providerLabel,
      });
      return;
    }

    setState("error");
    setErrorMessage(result.message);
  };

  const missingConfiguration = !assistantId || !providerKey;
  const connectDisabled =
    missingConfiguration || state === "connecting" || state === "connected";

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)]">
      <div className="flex gap-3 p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)]">
          <IntegrationIcon
            providerKey={providerKey}
            displayName={providerLabel}
            logoUrl={logoUrl}
            size={28}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-title-small text-[var(--content-strong)]">
            {surface.title ?? `Connect ${providerLabel}`}
          </div>
          <p className="mt-1 text-body-medium-lighter text-[var(--content-quiet)]">
            {description}
          </p>

          {scopes.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {scopes.map((scope) => (
                <span
                  key={scope}
                  className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-base)] px-2 py-0.5 text-label-small-default text-[var(--content-tertiary)]"
                >
                  {scope}
                </span>
              ))}
            </div>
          )}

          {missingConfiguration && (
            <div className="mt-3 flex items-center gap-2 text-body-small-default text-[var(--system-negative-strong)]">
              <XCircle className="h-4 w-4 shrink-0" />
              Missing assistant or provider details.
            </div>
          )}

          {state === "error" && errorMessage && (
            <div className="mt-3 flex items-start gap-2 text-body-small-default text-[var(--system-negative-strong)]">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {state === "connected" && (
            <div className="mt-3 flex items-center gap-2 text-body-small-default text-[var(--system-positive-strong)]">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Connected
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-base)] px-4 py-3">
        <button
          type="button"
          onClick={submitCancel}
          disabled={state === "connecting"}
          className="rounded-md px-3 py-2 text-body-medium-default text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-strong)] disabled:opacity-50"
        >
          Not now
        </button>
        <button
          type="button"
          onClick={handleConnect}
          disabled={connectDisabled}
          className="inline-flex items-center gap-2 rounded-md bg-[var(--primary-base)] px-3 py-2 text-body-medium-default text-[var(--content-inset)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {state === "connecting" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ExternalLink className="h-4 w-4" />
          )}
          {state === "connecting" ? "Waiting..." : connectLabel}
        </button>
      </div>
    </div>
  );
}
