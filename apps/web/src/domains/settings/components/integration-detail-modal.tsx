import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import {
    assistantsOauthConnectionsListOptions,
    assistantsOauthConnectionsListQueryKey,
    assistantsOauthDisconnectByConnectionCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import { useOAuthConnect } from "@/domains/settings/hooks/use-oauth-connect";
import type { PlatformGateState } from "@/hooks/use-platform-gate";
import { extractErrorMessage } from "@/utils/api-errors";

import { ManagedTab } from "@/domains/settings/components/managed-oauth-tab";
import { YourOwnTab } from "@/domains/settings/components/your-own-oauth-tab";

type ModalTab = "managed" | "your-own";

interface IntegrationDetailModalProps {
  assistantId: string;
  providerKey: string;
  displayName: string;
  description: string | null;
  logoUrl: string | null;
  platformGate: PlatformGateState;
  onClose: () => void;
}

/**
 * Provider OAuth configuration modal with Managed / Your Own segmented tabs.
 * Managed tab handles Vellum-hosted OAuth connections via popup or native flow.
 * Your Own tab handles user-provided OAuth app credentials.
 */
export function IntegrationDetailModal({
  assistantId,
  providerKey,
  displayName,
  description,
  logoUrl,
  platformGate,
  onClose,
}: IntegrationDetailModalProps) {
  const queryClient = useQueryClient();
  const managedAvailable = platformGate === "full";
  const [activeTab, setActiveTab] = useState<ModalTab>(
    platformGate === "gated" ? "your-own" : "managed",
  );
  const [pendingDisconnectId, setPendingDisconnectId] = useState<string | null>(
    null,
  );
  const [connectionPendingDisconnect, setConnectionPendingDisconnect] =
    useState<OAuthConnection | null>(null);

  const connectionsQueryKey = assistantsOauthConnectionsListQueryKey({
    path: { assistant_id: assistantId },
  });

  const { data: allConnections, isLoading: connectionsLoading } = useQuery({
    ...assistantsOauthConnectionsListOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: managedAvailable,
  });

  const providerConnections: OAuthConnection[] = (allConnections ?? []).filter(
    (c) => c.provider === providerKey && c.connected,
  );

  const { handleConnect, oauthInProgress, startOAuthPending } = useOAuthConnect({
    assistantId,
    providerKey,
    displayName,
    managedAvailable,
    connectionsQueryKey,
    allConnections,
  });

  const disconnectOAuth = useMutation({
    ...assistantsOauthDisconnectByConnectionCreateMutation(),
    onSuccess(_data, variables) {
      toast.success(`${displayName} account disconnected.`);
      const connectionId = variables.path.connection_id;
      queryClient.setQueryData(
        connectionsQueryKey,
        (old: OAuthConnection[] | undefined) =>
          old?.filter((c) => c.id !== connectionId),
      );
      queryClient.invalidateQueries({ queryKey: connectionsQueryKey });
      setPendingDisconnectId(null);
    },
    onError(error) {
      const detail = extractErrorMessage(
        error,
        undefined,
        `Failed to disconnect ${displayName} account.`,
      );
      toast.error(detail);
      setPendingDisconnectId(null);
    },
  });

  // Modal: Escape key + body scroll lock
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const handleDisconnect = (connection: OAuthConnection) => {
    setConnectionPendingDisconnect(connection);
  };

  const confirmDisconnect = () => {
    const connection = connectionPendingDisconnect;
    setConnectionPendingDisconnect(null);
    if (!connection) {
      return;
    }
    setPendingDisconnectId(connection.id);
    disconnectOAuth.mutate({
      path: { assistant_id: assistantId, connection_id: connection.id },
    });
  };

  const subtitle = description
    ? `Configure ${displayName} OAuth for ${description}`
    : `Configure ${displayName} OAuth`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="integration-modal-title"
        className="flex w-full max-w-[520px] flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-[var(--surface-lift)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-base)] px-5 py-4 dark:border-[var(--border-base)]">
          <div className="flex items-center gap-3">
            <IntegrationIcon
              providerKey={providerKey}
              displayName={displayName}
              logoUrl={logoUrl}
              size={32}
            />
            <div>
              <h2
                id="integration-modal-title"
                className="text-title-small text-[var(--content-default)]"
              >
                {displayName} OAuth
              </h2>
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                {subtitle}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="compact"
            iconOnly={<X />}
            aria-label="Close"
            onClick={onClose}
          />
        </div>

        <div className="space-y-4 px-5 py-4">
          {platformGate !== "gated" && (
            <div
              role="tablist"
              aria-label="OAuth mode"
              className="flex w-full rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] p-0.5 dark:border-[var(--border-base)] dark:bg-[var(--surface-base)]/40"
            >
              <TabButton
                active={activeTab === "managed"}
                onClick={() => setActiveTab("managed")}
              >
                Managed
              </TabButton>
              <TabButton
                active={activeTab === "your-own"}
                onClick={() => setActiveTab("your-own")}
              >
                Your Own
              </TabButton>
            </div>
          )}

          {activeTab === "managed" && platformGate !== "gated" ? (
            platformGate === "disabled" ? (
              <Notice tone="info">
                Log in to the Vellum platform to manage OAuth connections.
              </Notice>
            ) : (
              <ManagedTab
                displayName={displayName}
                providerKey={providerKey}
                logoUrl={logoUrl}
                connections={providerConnections}
                connectionsLoading={connectionsLoading}
                startPending={startOAuthPending}
                oauthInProgress={oauthInProgress}
                disconnectingId={
                  disconnectOAuth.isPending ? pendingDisconnectId : null
                }
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
              />
            )
          ) : (
            <YourOwnTab
              assistantId={assistantId}
              providerKey={providerKey}
              displayName={displayName}
              logoUrl={logoUrl}
            />
          )}
        </div>

        <div className="flex justify-end border-t border-[var(--border-base)] px-5 py-3 dark:border-[var(--border-base)]">
          <Button variant="outlined" size="compact" onClick={onClose}>
            Confirm
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={connectionPendingDisconnect !== null}
        title={`Disconnect ${displayName}?`}
        message={
          connectionPendingDisconnect
            ? `Disconnect ${connectionPendingDisconnect.account_label ?? `${displayName} Account`}? You can reconnect later.`
            : ""
        }
        confirmLabel="Disconnect"
        destructive
        onConfirm={confirmDisconnect}
        onCancel={() => setConnectionPendingDisconnect(null)}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 cursor-pointer rounded-[5px] px-3 py-1.5 text-body-medium-default transition-colors ${
        active
          ? "bg-white text-[var(--content-default)] shadow-sm dark:bg-[var(--surface-lift)] dark:text-[var(--content-default)]"
          : "text-[var(--content-secondary)] hover:text-[var(--content-default)] dark:text-[var(--content-disabled)] dark:hover:text-[var(--content-default)]"
      }`}
    >
      {children}
    </button>
  );
}
