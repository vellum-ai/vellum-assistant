import { Tooltip } from "@vellumai/design-library";
import {
  CheckCircle2,
  ExternalLink,
  Info,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import {
  fetchManagedOAuthProvider,
  type ManagedOAuthProviderSummary,
} from "@/lib/auth/managed-oauth";
import {
  type OAuthConnectSurfaceData,
  OAuthConnectSurfaceDataSchema,
} from "@vellumai/assistant-api";

import type { Surface } from "@/domains/chat/types/types";
import { useManagedOAuthConnect } from "@/hooks/use-managed-oauth-connect";
import { useTranslation } from "@/i18n";

interface OAuthConnectSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  assistantId?: string | null;
  assistantDisplayName?: string | null;
  /** Injectable connect flow, so tests and stories can drive the card. */
  useConnect?: typeof useManagedOAuthConnect;
  /** Injectable provider lookup, for the same reason. */
  fetchProvider?: (
    assistantId: string,
    providerKey: string,
  ) => Promise<ManagedOAuthProviderSummary | null>;
}

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
  thisAccountLabel: string,
): string {
  const raw =
    data.displayName ||
    provider?.display_name ||
    (data.providerKey
      ? titleizeProviderKey(data.providerKey)
      : thisAccountLabel);
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
  const { t } = useTranslation("chat");
  const assistantLabel =
    assistantDisplayName?.trim() || t("oauthConnectSurface.yourAssistant");
  return (
    <Tooltip
      content={t("oauthConnectSurface.approvalTooltip", {
        name: assistantLabel,
      })}
      side="top"
      align="end"
    >
      <button
        type="button"
        aria-label={t("oauthConnectSurface.approvalAria")}
        className="inline-flex h-5 w-5 items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-strong)] keyboard-focus:outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}

/**
 * Surfaces whose connection has already been reported.
 *
 * One `oauth_connect` surface can be mounted twice at once: the transcript
 * keeps its card while the voice room renders its own copy of the same
 * surface. Both read the one provider-keyed attempt, so both observe the
 * connection, and a per-instance guard would let each of them submit. Keyed by
 * surface id, which is what the daemon dedupes on.
 *
 * The claim is released when the reporting card unmounts. A completed surface
 * renders as a static summary rather than this card, so a later mount means
 * the submission never took, and reporting again is the point.
 */
const reportedSurfaceIds = new Set<string>();

export function OAuthConnectSurface({
  surface,
  onAction,
  assistantId,
  assistantDisplayName,
  useConnect = useManagedOAuthConnect,
  fetchProvider = fetchManagedOAuthProvider,
}: OAuthConnectSurfaceProps) {
  const { t } = useTranslation("chat");
  // The wire keeps surface `data` opaque; narrow it with the canonical schema
  // (tolerant, so a real payload never fails to parse) rather than an
  // unchecked cast or a re-declared local interface.
  const parsedData = OAuthConnectSurfaceDataSchema.safeParse(surface.data);
  const data: OAuthConnectSurfaceData = parsedData.success
    ? parsedData.data
    : { providerKey: "" };
  const providerKey = data.providerKey;
  const [provider, setProvider] = useState<ManagedOAuthProviderSummary | null>(
    null,
  );
  const mountedRef = useRef(true);
  const claimedSurfaceRef = useRef<string | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (claimedSurfaceRef.current) {
        reportedSurfaceIds.delete(claimedSurfaceRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!assistantId || !providerKey) {
      return;
    }
    void fetchProvider(assistantId, providerKey).then((result) => {
      if (!cancelled) {
        setProvider(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [assistantId, fetchProvider, providerKey]);

  const providerLabel = getProviderLabel(
    data,
    provider,
    t("oauthConnectSurface.thisAccount"),
  );
  const logoUrl = data.logoUrl ?? provider?.logo_url ?? null;
  const description =
    data.description ??
    provider?.description ??
    t("oauthConnectSurface.defaultDescription", { name: providerLabel });

  const connect = useConnect({
    assistantId: assistantId ?? "",
    providerKey,
    providerLabel,
    requestedScopes: data.requestedScopes,
  });

  // The connection the platform reports is the outcome, whenever and wherever
  // it lands: this card, the settings integrations tab, or another device.
  useEffect(() => {
    if (
      connect.status !== "connected" ||
      reportedSurfaceIds.has(surface.surfaceId)
    ) {
      return;
    }
    reportedSurfaceIds.add(surface.surfaceId);
    claimedSurfaceRef.current = surface.surfaceId;
    onAction(surface.surfaceId, "connect", {
      status: "connected",
      providerKey,
      providerLabel,
      connectionId: connect.connection?.id,
      accountLabel: connect.connection?.account_label,
      scopesGranted: connect.connection?.scopes_granted ?? [],
    });
  }, [
    connect.status,
    connect.connection,
    onAction,
    providerKey,
    providerLabel,
    surface.surfaceId,
  ]);

  // Dismissing is the only thing that cancels. An authorization window that
  // stops reporting says nothing about what the user decided.
  const submitCancel = () => {
    connect.dismiss();
    onAction(surface.surfaceId, "cancel", {
      status: "cancelled",
      providerKey,
      providerLabel,
    });
  };

  const handleConnect = () => {
    if (!assistantId || !providerKey) {
      return;
    }
    connect.connect();
  };

  const missingConfiguration = !assistantId || !providerKey;
  const isAttempting = connect.status === "attempting";
  const isConnected = connect.status === "connected";
  const connectDisabled = missingConfiguration || isAttempting || isConnected;

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
              {surface.title ??
                t("oauthConnectSurface.connectTitle", { name: providerLabel })}
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
              <div className="mt-3 flex items-center gap-2 text-body-small-lighter text-[var(--system-negative-strong)]">
                <XCircle className="h-4 w-4 shrink-0" />
                {t("oauthConnectSurface.missingDetails")}
              </div>
            )}

            {connect.errorMessage && (
              <div className="mt-3 flex items-start gap-2 text-body-small-default text-[var(--system-negative-strong)]">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{connect.errorMessage}</span>
              </div>
            )}

            {isConnected && (
              <div className="mt-3 flex items-center gap-2 text-body-small-default text-[var(--system-positive-strong)]">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                {t("oauthConnectSurface.connected")}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2">
          <button
            type="button"
            aria-label={t("oauthConnectSurface.dismiss")}
            title={t("oauthConnectSurface.dismiss")}
            onClick={submitCancel}
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
            {isAttempting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ExternalLink className="h-4 w-4" />
            )}
            {isAttempting
              ? t("oauthConnectSurface.waiting")
              : t("oauthConnectSurface.connect")}
          </button>
        </div>
      </div>
    </div>
  );
}
