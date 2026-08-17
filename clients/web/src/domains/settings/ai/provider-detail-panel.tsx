import { useEffect, useMemo, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { DetailShell } from "@/components/detail-shell";
import { ProviderEditorContent } from "@/domains/settings/ai/provider-editor-content";
import { providerConnectionDisplayName } from "@/domains/settings/ai/provider-editor-constants";
import {
  configLlmDefaultproviderGetQueryKey,
  inferenceProviderconnectionsGetOptions,
  inferenceProviderconnectionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";

interface ProviderDetailPanelProps {
  assistantId: string;
  /** Connection name to edit, or `null` for the add-provider flow. */
  connectionName: string | null;
  onClose: () => void;
}

/**
 * Sidepanel host for the provider editor: DetailShell chrome around
 * ProviderEditorContent's panel variant. Editing rotates keys and display
 * fields for an existing connection; the add flow runs the shared
 * ProviderCreateForm (via the editor's create mode).
 *
 * Hosts must remount the panel per selection (key by `connectionName`) -
 * the editor snapshots the connection's values on mount.
 */
export function ProviderDetailPanel({
  assistantId,
  connectionName,
  onClose,
}: ProviderDetailPanelProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  // Set by the footer row's callback ref, then handed to the editor as its
  // portal target. Null on the first render, so the actions land one commit
  // after the body.
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const { data } = useQuery(
    inferenceProviderconnectionsGetOptions({
      path: { assistant_id: assistantId },
    }),
  );
  const connections = useMemo(() => data?.connections ?? [], [data]);
  const connection = useMemo(
    () =>
      connectionName == null
        ? undefined
        : connections.find((c) => c.name === connectionName),
    [connectionName, connections],
  );

  // The open connection can vanish underneath the panel (deleted from a
  // row kebab, or removed on another device). Close rather than editing a
  // ghost.
  const connectionMissing =
    connectionName != null && data != null && connection == null;
  useEffect(() => {
    if (connectionMissing) {
      onClose();
    }
  }, [connectionMissing, onClose]);

  function handleSaved() {
    void queryClient.invalidateQueries({
      queryKey: inferenceProviderconnectionsGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
    // A saved key/connection can fix the default provider's availability;
    // refresh the status so the card's notice clears without a reload.
    // Harmless no-op against assistants whose status query is gated off.
    void queryClient.invalidateQueries({
      queryKey: configLlmDefaultproviderGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
    onClose();
  }

  return (
    <DetailShell
      title={
        connection
          ? providerConnectionDisplayName(connection)
          : t("providerDetailPanel.addProviderTitle")
      }
      closeVariant="outlined"
      onClose={onClose}
      // The editor owns the save state, so rather than lifting it we hand it
      // this row to portal its Cancel/Save into. That puts the actions in the
      // shell's pinned footer, matching `ProfileDetailPanel`.
      footer={<div ref={setActionsSlot} className="flex justify-end gap-2" />}
    >
      {/* Wait for the list before mounting an edit session so the editor
          never snapshots an absent connection. The add flow has no
          snapshot dependency and mounts immediately. */}
      {connectionName == null || connection != null ? (
        <ProviderEditorContent
          mode={connection ? "edit" : "create"}
          connection={connection}
          variant="panel"
          actionsSlot={actionsSlot}
          assistantId={assistantId}
          existingNames={connections.map((c) => c.name)}
          connections={connections}
          onSave={handleSaved}
          onCancel={onClose}
        />
      ) : null}
    </DetailShell>
  );
}
