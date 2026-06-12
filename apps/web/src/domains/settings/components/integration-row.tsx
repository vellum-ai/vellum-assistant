import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, Pencil, XCircle } from "lucide-react";
import { useState } from "react";

import {
    assistantsOauthConnectionsListQueryKey,
    assistantsOauthConnectionsListSetQueryData,
    useAssistantsOauthDisconnectByConnectionCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@vellumai/design-library/components/bottom-sheet";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { PanelItem } from "@vellumai/design-library/components/panel-item";
import { Popover } from "@vellumai/design-library/components/popover";
import { toast } from "@vellumai/design-library/components/toast";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import type { PlatformGateState } from "@/hooks/use-platform-gate";

import { extractErrorMessage } from "@/utils/api-errors";

interface IntegrationRowProps {
  assistantId: string;
  providerKey: string;
  displayName: string;
  description: string | null;
  logoUrl: string | null;
  connection: OAuthConnection | null;
  platformGate: PlatformGateState;
  onConfigure: () => void;
}

/**
 * Renders a single integration row matching the macOS desktop layout:
 * icon + title/description on the left, right-aligned "Enable" button
 * when not connected, or "Configure" dropdown menu when connected.
 *
 * The Configure menu offers:
 *   - "Edit connections": opens a detail modal via `onConfigure`.
 *   - "Disable":          disconnects the account (with confirmation).
 */
export function IntegrationRow({
  assistantId,
  providerKey,
  displayName,
  description,
  logoUrl,
  connection,
  platformGate,
  onConfigure,
}: IntegrationRowProps) {
  const queryClient = useQueryClient();
  const isConnected = Boolean(connection?.connected);

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDisableOpen, setConfirmDisableOpen] = useState(false);
  const isMobile = useIsMobile();

  const connectionsQueryKey = assistantsOauthConnectionsListQueryKey({
    path: { assistant_id: assistantId },
  });

  const connectionsOpts = { path: { assistant_id: assistantId } };

  const disconnectOAuth = useAssistantsOauthDisconnectByConnectionCreateMutation({
    onSuccess(_data, variables) {
      toast.success(`${displayName} account disconnected.`);
      const connectionId = variables.path.connection_id;
      assistantsOauthConnectionsListSetQueryData(
        queryClient,
        connectionsOpts,
        (old) => old?.filter((c) => c.id !== connectionId),
      );
      queryClient.invalidateQueries({ queryKey: connectionsQueryKey });
    },
    onError(error) {
      const detail = extractErrorMessage(
        error,
        undefined,
        `Failed to disconnect ${displayName} account.`,
      );
      toast.error(detail);
    },
  });

  const handleDisable = () => {
    if (!connection?.id) {
      return;
    }
    setConfirmDisableOpen(true);
  };

  const confirmDisable = () => {
    setConfirmDisableOpen(false);
    if (!connection?.id) {
      return;
    }
    disconnectOAuth.mutate({
      path: { assistant_id: assistantId, connection_id: connection.id },
    });
  };

  return (
    <>
      <Card.Root>
        <Card.Body padding="sm" className="flex items-center gap-4 px-4">
          <IntegrationIcon
            providerKey={providerKey}
            displayName={displayName}
            logoUrl={logoUrl}
            size={32}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-title-small text-[var(--content-default)]">
              {displayName}
            </p>
            {description && (
              <p className="truncate text-body-medium-lighter text-[var(--content-tertiary)]">
                {description}
              </p>
            )}
          </div>
          {isConnected && platformGate === "full" ? (
            <div className="shrink-0">
              <IntegrationConfigureMenu
                displayName={displayName}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                onEditConnections={() => {
                  setMenuOpen(false);
                  onConfigure();
                }}
                onDisable={() => {
                  setMenuOpen(false);
                  handleDisable();
                }}
                disablePending={disconnectOAuth.isPending}
                isMobile={isMobile}
              />
            </div>
          ) : (
            <Button
              variant="primary"
              onClick={onConfigure}
              className="shrink-0"
            >
              Enable
            </Button>
          )}
        </Card.Body>
      </Card.Root>
      <ConfirmDialog
        open={confirmDisableOpen}
        title={`Disconnect ${displayName}?`}
        message={`Disconnect your ${displayName} account? You can reconnect it later.`}
        confirmLabel="Disconnect"
        destructive
        onConfirm={confirmDisable}
        onCancel={() => setConfirmDisableOpen(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// IntegrationConfigureMenu — desktop popover / mobile bottom-sheet wrapper
// for the connected-integration "Configure" action menu. Extracted so the
// branch can be unit-tested without standing up the parent's mutations.
// ---------------------------------------------------------------------------

export interface IntegrationConfigureMenuProps {
  displayName: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onEditConnections: () => void;
  onDisable: () => void;
  disablePending: boolean;
  /** Branch hint — production callers pass `useIsMobile()`. */
  isMobile: boolean;
}

export function IntegrationConfigureMenu({
  displayName,
  open,
  onOpenChange,
  onEditConnections,
  onDisable,
  disablePending,
  isMobile,
}: IntegrationConfigureMenuProps) {
  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
        <BottomSheet.Trigger asChild>
          <Button
            variant="outlined"
            rightIcon={<ChevronDown />}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            Configure
          </Button>
        </BottomSheet.Trigger>
        <BottomSheet.Content>
          {/* Use the integration name as the (visible) sheet title — gives
              the user a clear anchor for which integration they're acting on. */}
          <BottomSheet.Header>
            <BottomSheet.Title>{displayName}</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body>
            <PanelItem
              icon={Pencil}
              label="Edit connections"
              onSelect={onEditConnections}
            />
            <PanelItem
              icon={disablePending ? Loader2 : XCircle}
              label="Disable"
              onSelect={() => {
                if (disablePending) return;
                onDisable();
              }}
            />
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <Button
          variant="outlined"
          rightIcon={<ChevronDown />}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          Configure
        </Button>
      </Popover.Trigger>
      <Popover.Content
        align="end"
        sideOffset={4}
        role="menu"
        className="w-56 overflow-hidden p-0"
      >
        <Button
          type="button"
          role="menuitem"
          variant="ghost"
          onClick={onEditConnections}
          className="w-full justify-start rounded-none"
          leftIcon={<Pencil aria-hidden />}
        >
          Edit connections
        </Button>
        <Button
          type="button"
          role="menuitem"
          variant="dangerGhost"
          onClick={onDisable}
          disabled={disablePending}
          className="w-full justify-start rounded-none"
          leftIcon={
            disablePending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <XCircle aria-hidden />
            )
          }
        >
          Disable
        </Button>
      </Popover.Content>
    </Popover.Root>
  );
}
