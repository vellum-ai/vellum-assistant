import { Tooltip } from "@vellumai/design-library";
import {
    CheckCircle2,
    ExternalLink,
    Info,
    Loader2,
    X,
    XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";

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
}

interface OAuthConnectSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  assistantId?: string | null;
  assistantDisplayName?: string | null;
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
  const raw =
    data.displayName ||
    provider?.display_name ||
    (data.providerKey ? titleizeProviderKey(data.providerKey) : "this account");
  // Normalize once at the resolver so the title, description, icon, and
  // action payloads never double the verb (e.g. "Connect Connect Gmail")
  // when a caller-supplied displayName already begins with "Connect ".
  return stripConnectVerb(raw);
}

/**
 * Strip a leading "Connect "/"Connected " verb from a provider label so a
 * caller-supplied `displayName` like "Connect Gmail" doesn't double the verb
 * when prefixed (e.g. avoids "Connect Connect Gmail").
 */
function stripConnectVerb(label: string): string {
  return label.replace(/^connect(?:ed)?\s+/i, "");
}

function OAuthApprovalInfo({
  assistantDisplayName,
}: {
  assistantDisplayName?: string | null;
}) {
  const assistantLabel = assistantDisplayName?.trim() || "Your assistant";
  return (
    <Tooltip
      content={`${assistantLabel} never acts on your behalf without your approval`}
      side="top"
      align="end"
    >
      <button
        type="button"
        aria-label="About assistant approval"
        className="inline-flex h-5 w-5 items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-strong)] keyboard-focus:outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}

export function OAuthConnectSurface({
  surface,
  onAction,
  assistantId,
  assistantDisplayName,
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
    <div className="rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 gap-3">
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
              <span>{description}</span>
              <span className="ml-1.5 inline-flex align-middle">
                <OAuthApprovalInfo
                  assistantDisplayName={assistantDisplayName}
                />
              </span>
            </p>

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

        <div className="flex shrink-0 items-center justify-end gap-2">
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={submitCancel}
            disabled={state === "connecting"}
            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-strong)] disabled:opacity-50"
          >
            <X className="h-4 w-4" />
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
            {state === "connecting" ? "Waiting..." : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
