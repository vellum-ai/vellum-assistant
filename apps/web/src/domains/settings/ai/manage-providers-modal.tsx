import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Modal } from "@vellum/design-library/components/modal";
import { Tag } from "@vellum/design-library/components/tag";
import { Typography } from "@vellum/design-library/components/typography";

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderConnection,
  deleteConnection,
  listConnections,
} from "@/domains/settings/ai/provider-connections-client";
import { ProviderEditorContent } from "@/domains/settings/ai/provider-editor-modal";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAuthSummary(auth: ProviderConnection["auth"]): string {
  switch (auth.type) {
    case "api_key":
      return `API key · ${auth.credential}`;
    case "oauth_subscription":
      return "ChatGPT Subscription";
    case "platform":
      return "Managed proxy";
    case "none":
      return "None (local)";
    default:
      return (auth as { type: string }).type;
  }
}

function filterFlaggedConnections(
  connections: ProviderConnection[],
  openAICompatibleEndpointsEnabled: boolean,
): ProviderConnection[] {
  if (openAICompatibleEndpointsEnabled) return connections;
  return connections.filter((c) => c.provider !== "openai-compatible");
}

// ---------------------------------------------------------------------------
// ManageProvidersModal
// ---------------------------------------------------------------------------

interface ManageProvidersModalProps {
  isOpen: boolean;
  assistantId: string;
  onClose: () => void;
}

export function ManageProvidersModal({
  isOpen,
  assistantId,
  onClose,
}: ManageProvidersModalProps) {
  const openAICompatibleEndpoints = useAssistantFeatureFlagStore.use.openAICompatibleEndpoints();
  const chatgptSubscriptionAuth = useAssistantFeatureFlagStore.use.chatgptSubscriptionAuth();
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ProviderConnection | null>(null);

  // Request versioning: prevents stale listConnections responses from
  // overwriting newer local state (e.g. after handleEditorSave).
  const listVersionRef = useRef(0);

  const refreshList = useCallback(() => {
    const version = ++listVersionRef.current;
    setLoading(true);
    setLoadError(null);
    void listConnections(assistantId)
      .then((conns) => {
        if (listVersionRef.current !== version) return; // stale response
        setConnections(
          filterFlaggedConnections(conns, openAICompatibleEndpoints),
        );
        setLoading(false);
      })
      .catch(() => {
        if (listVersionRef.current !== version) return; // stale response
        setLoadError("Failed to load connections. Please try again.");
        setLoading(false);
      });
  }, [assistantId, openAICompatibleEndpoints]);

  // Load list whenever the outer modal opens.
  useEffect(() => {
    if (isOpen) refreshList();
  }, [isOpen, refreshList]);

  function handleEditorSave(saved: ProviderConnection) {
    // Invalidate any in-flight refreshList so it won't overwrite this save.
    listVersionRef.current++;

    // Update the local list: replace existing entry or append new one.
    setConnections((prev) => {
      if (
        saved.provider === "openai-compatible" &&
        !openAICompatibleEndpoints
      ) {
        return prev;
      }
      const idx = prev.findIndex((c) => c.name === saved.name);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved];
    });
    setEditorOpen(false);
    setEditingConnection(null);
  }

  const existingNames = connections.map((c) => c.name);

  // Cancel the editor: returns to list view without saving. Used by the
  // editor's footer Cancel button AND by view-aware onOpenChange when the
  // user dismisses the modal while in editor view (X / ESC / backdrop click).
  const cancelEditor = () => {
    setEditorOpen(false);
    setEditingConnection(null);
  };

  // Single Modal.Root for both views (list + editor). Body content swaps
  // based on `editorOpen` — this is the master/detail pattern, matching the
  // macOS `ProvidersSheet` flow. View-aware `onOpenChange`: a close
  // intent (X / ESC / backdrop) returns to the list when in editor view,
  // and closes the whole modal when in list view.
  return (
    <Modal.Root
      open={isOpen}
      onOpenChange={(next) => {
        if (next) return;
        if (editorOpen) {
          cancelEditor();
        } else {
          onClose();
        }
      }}
    >
      {isOpen ? (
        editorOpen ? (
          <ProviderEditorContent
            mode={
              !editingConnection
                ? "create"
                : editingConnection.isManaged
                  ? "managed-edit"
                  : "edit"
            }
            connection={editingConnection ?? undefined}
            assistantId={assistantId}
            existingNames={existingNames}
            openAICompatibleEndpointsEnabled={openAICompatibleEndpoints}
            chatgptSubscriptionEnabled={chatgptSubscriptionAuth}
            onSave={handleEditorSave}
            onCancel={cancelEditor}
          />
        ) : (
          <ManageProvidersModalInner
            connections={connections}
            loading={loading}
            loadError={loadError}
            assistantId={assistantId}
            onClose={onClose}
            onEditClick={(conn) => {
              setEditingConnection(conn);
              setEditorOpen(true);
            }}
            onNewClick={() => {
              setEditingConnection(null);
              setEditorOpen(true);
            }}
            onConnectionDeleted={(name) => {
              setConnections((prev) => prev.filter((c) => c.name !== name));
            }}
          />
        )
      ) : null}
    </Modal.Root>
  );
}

// ---------------------------------------------------------------------------
// ManageProvidersModalInner
// ---------------------------------------------------------------------------

interface ManageProvidersModalInnerProps {
  connections: ProviderConnection[];
  loading: boolean;
  loadError: string | null;
  assistantId: string;
  onClose: () => void;
  onEditClick: (conn: ProviderConnection) => void;
  onNewClick: () => void;
  onConnectionDeleted: (name: string) => void;
}

function ManageProvidersModalInner({
  connections,
  loading,
  loadError,
  assistantId,
  onClose,
  onEditClick,
  onNewClick,
  onConnectionDeleted,
}: ManageProvidersModalInnerProps) {
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});

  async function handleDelete(name: string) {
    setDeleting((prev) => ({ ...prev, [name]: true }));
    setDeleteErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    try {
      await deleteConnection(assistantId, name);
      onConnectionDeleted(name);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 409) {
        setDeleteErrors((prev) => ({
          ...prev,
          [name]:
            "Connection is in use by one or more profiles. Remove those references first.",
        }));
      } else if (status === 404) {
        // Already gone — remove from local list silently.
        onConnectionDeleted(name);
      } else {
        setDeleteErrors((prev) => ({
          ...prev,
          [name]: "Failed to delete connection. Please try again.",
        }));
      }
    } finally {
      setDeleting((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  }

  return (
    <Modal.Content size="md">
      <Modal.Header>
        <Modal.Title>Provider Connections</Modal.Title>
        <Modal.Description>
          Manage inference provider connections. Each connection binds a name to a
          provider and auth configuration.
        </Modal.Description>
      </Modal.Header>

      <Modal.Body>
        {loading ? (
          <div className="space-y-2 py-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-10 animate-pulse rounded-lg bg-[var(--surface-active)]"
              />
            ))}
          </div>
        ) : loadError ? (
          <Typography
            variant="body-medium-default"
            as="p"
            className="py-4 text-center text-(--system-negative-strong)"
          >
            {loadError}
          </Typography>
        ) : connections.length === 0 ? (
          <Typography
            variant="body-medium-lighter"
            as="p"
            className="py-4 text-center text-(--content-tertiary)"
          >
            No connections yet. Create one to get started.
          </Typography>
        ) : (
          <div className="space-y-1">
            {connections.map((conn) => {
              const isDeleting = deleting[conn.name] ?? false;
              const deleteError = deleteErrors[conn.name];
              const isManaged = conn.isManaged ?? false;

              return (
                <div key={conn.name}>
                  <div className="flex items-center gap-3 rounded-lg px-2 py-2">
                    {/* Connection info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Typography
                          variant="body-medium-default"
                          as="span"
                          className="text-(--content-default)"
                        >
                          {conn.label ?? conn.name}
                        </Typography>
                        {isManaged && (
                          <Tag
                            tone="positive"
                            title="Managed by Platform — auth is locked, but you can rename this connection."
                          >
                            Platform
                          </Tag>
                        )}
                      </div>
                      <Typography
                        variant="body-medium-lighter"
                        as="p"
                        className="mt-0.5 text-(--content-tertiary)"
                      >
                        {conn.label ? `${conn.name} · ` : ""}
                        {PROVIDER_DISPLAY_NAMES[conn.provider] ?? conn.provider}
                        {" · "}
                        {formatAuthSummary(conn.auth)}
                      </Typography>
                    </div>

                    {/* Actions */}
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="ghost"
                        size="compact"
                        onClick={() => onEditClick(conn)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="compact"
                        iconOnly={<Trash2 />}
                        aria-label={`Delete ${conn.name}`}
                        disabled={isManaged || isDeleting}
                        title={
                          isManaged
                            ? "Managed connections cannot be deleted"
                            : undefined
                        }
                        onClick={() => void handleDelete(conn.name)}
                        tintColor="var(--system-negative-strong)"
                      />
                    </div>
                  </div>

                  {deleteError ? (
                    <Typography
                      variant="body-small-default"
                      as="p"
                      className="px-2 pb-1 text-(--system-negative-strong)"
                    >
                      {deleteError}
                    </Typography>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Modal.Body>

      <Modal.Footer className="justify-between">
        <Button variant="outlined" size="compact" onClick={onNewClick}>
          + New Connection
        </Button>
        <Button variant="outlined" size="compact" onClick={onClose}>
          Done
        </Button>
      </Modal.Footer>
    </Modal.Content>
  );
}
