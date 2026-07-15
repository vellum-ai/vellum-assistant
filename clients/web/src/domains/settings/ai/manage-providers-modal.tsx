import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";

import {
  configGetQueryKey,
  configLlmDefaultproviderGetOptions,
  configLlmDefaultproviderGetQueryKey,
  configLlmDefaultproviderPutMutation,
  inferenceProviderconnectionsGetOptions,
  inferenceProviderconnectionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { inferenceProviderconnectionsByNameDelete } from "@/generated/daemon/sdk.gen";

import type {
  DefaultProviderStatus,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import { captureError } from "@/lib/sentry/capture-error";
import { useSupportsDefaultProviderSettings } from "@/lib/backwards-compat/default-provider-settings";
import { ProviderEditorContent } from "@/domains/settings/ai/provider-editor-modal";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DefaultProviderId = NonNullable<DefaultProviderStatus["provider"]>;

// Exhaustive against the generated union: a provider added to or removed
// from the daemon's default-provider enum fails compilation here.
const DEFAULT_PROVIDER_ELIGIBLE: Record<DefaultProviderId, true> = {
  anthropic: true,
  openai: true,
  gemini: true,
  fireworks: true,
  openrouter: true,
  vellum: true,
};

function isDefaultProviderId(provider: string): provider is DefaultProviderId {
  return provider in DEFAULT_PROVIDER_ELIGIBLE;
}

/**
 * Extracts the daemon's error-envelope message (`{ error: { message } }`,
 * per the runtime's http-errors adapter) from a generated-SDK `error` field.
 */
function errorEnvelopeMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const inner = (error as { error?: unknown }).error;
  if (typeof inner !== "object" || inner === null) {
    return undefined;
  }
  const message = (inner as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0
    ? message
    : undefined;
}

/**
 * Card title: user label, else the provider's display name. Subscription
 * auth gets its own identity — without it, an unlabeled ChatGPT row (stored
 * as provider "openai") would be indistinguishable from an OpenAI API-key
 * card now that the auth subtitle is gone.
 */
function providerCardTitle(conn: ProviderConnection): string {
  if (conn.label) {
    return conn.label;
  }
  if (conn.auth.type === "oauth_subscription") {
    return PROVIDER_DISPLAY_NAMES.chatgpt;
  }
  return PROVIDER_DISPLAY_NAMES[conn.provider] ?? conn.provider;
}

/**
 * Card subtitle: the internal key and provider name, omitting parts that
 * would just repeat the title.
 */
function providerCardSubtitle(conn: ProviderConnection): string {
  const title = providerCardTitle(conn);
  const parts = [
    conn.name,
    PROVIDER_DISPLAY_NAMES[conn.provider] ?? conn.provider,
  ];
  return [...new Set(parts)].filter((p) => p !== title).join(" · ");
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
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingConnection, setEditingConnection] =
    useState<ProviderConnection | null>(null);

  const queryClient = useQueryClient();
  const queryOpts = inferenceProviderconnectionsGetOptions({
    path: { assistant_id: assistantId },
  });
  const {
    data,
    isLoading: loading,
    isError,
  } = useQuery({
    ...queryOpts,
    enabled: isOpen,
  });

  // Older assistants 404 the default-provider routes; the gate keeps the
  // query dark and the marker UI hidden against them.
  const supportsDefaultProvider = useSupportsDefaultProviderSettings();
  const { data: defaultProviderStatus } = useQuery({
    ...configLlmDefaultproviderGetOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: isOpen && supportsDefaultProvider,
  });

  const connections = useMemo(() => data?.connections ?? [], [data]);

  function handleDefaultChanged() {
    void queryClient.invalidateQueries({
      queryKey: configLlmDefaultproviderGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
    void queryClient.invalidateQueries({
      queryKey: configGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
  }

  function handleEditorSave(_saved: ProviderConnection) {
    void queryClient.invalidateQueries({
      queryKey: inferenceProviderconnectionsGetQueryKey({
        path: { assistant_id: assistantId },
      }),
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
        if (next) {
          return;
        }
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
            mode={!editingConnection ? "create" : "edit"}
            connection={editingConnection ?? undefined}
            assistantId={assistantId}
            existingNames={existingNames}
            onSave={handleEditorSave}
            onCancel={cancelEditor}
          />
        ) : (
          <ManageProvidersModalInner
            connections={connections}
            loading={loading}
            isError={isError}
            assistantId={assistantId}
            supportsDefaultProvider={supportsDefaultProvider}
            defaultConnectionName={
              supportsDefaultProvider
                ? (defaultProviderStatus?.resolvedConnectionName ?? null)
                : null
            }
            onDefaultChanged={handleDefaultChanged}
            onClose={onClose}
            onEditClick={(conn) => {
              setEditingConnection(conn);
              setEditorOpen(true);
            }}
            onNewClick={() => {
              setEditingConnection(null);
              setEditorOpen(true);
            }}
            onConnectionDeleted={() => {
              void queryClient.invalidateQueries({
                queryKey: inferenceProviderconnectionsGetQueryKey({
                  path: { assistant_id: assistantId },
                }),
              });
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
  isError: boolean;
  assistantId: string;
  /** False against assistants that predate the default-provider routes. */
  supportsDefaultProvider: boolean;
  /** Connection the default provider resolves to, or null when unknown. */
  defaultConnectionName: string | null;
  onDefaultChanged: () => void;
  onClose: () => void;
  onEditClick: (conn: ProviderConnection) => void;
  onNewClick: () => void;
  onConnectionDeleted: (name: string) => void;
}

function ManageProvidersModalInner({
  connections,
  loading,
  isError,
  assistantId,
  supportsDefaultProvider,
  defaultConnectionName,
  onDefaultChanged,
  onClose,
  onEditClick,
  onNewClick,
  onConnectionDeleted,
}: ManageProvidersModalInnerProps) {
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});

  const setDefault = useMutation({
    ...configLlmDefaultproviderPutMutation(),
    onMutate: (variables) => {
      const name = variables.body?.connectionName;
      if (!name) {
        return;
      }
      setRowErrors((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    },
    onSuccess: onDefaultChanged,
    onError: (error, variables) => {
      captureError(error, { context: "settings-ai-set-default-provider" });
      const name = variables.body?.connectionName;
      if (!name) {
        return;
      }
      setRowErrors((prev) => ({
        ...prev,
        [name]: "Failed to set default provider. Please try again.",
      }));
    },
  });

  function handleSetDefault(conn: ProviderConnection) {
    if (!isDefaultProviderId(conn.provider)) {
      return;
    }
    setDefault.mutate({
      path: { assistant_id: assistantId },
      body: { provider: conn.provider, connectionName: conn.name },
    });
  }

  async function handleDelete(name: string) {
    setDeleting((prev) => ({ ...prev, [name]: true }));
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    try {
      const { error, response } =
        await inferenceProviderconnectionsByNameDelete({
          path: { assistant_id: assistantId, name },
        });
      if (response?.ok || response?.status === 404) {
        // 404 means already gone — still remove from local list.
        onConnectionDeleted(name);
      } else if (response?.status === 409) {
        // The daemon's guard names what blocks the delete (default provider,
        // referencing profiles) and the fix — render it verbatim.
        setRowErrors((prev) => ({
          ...prev,
          [name]:
            errorEnvelopeMessage(error) ??
            "This provider is in use by one or more profiles. Remove those references first.",
        }));
      } else {
        setRowErrors((prev) => ({
          ...prev,
          [name]: "Failed to delete provider. Please try again.",
        }));
      }
    } catch {
      setRowErrors((prev) => ({
        ...prev,
        [name]: "Failed to delete provider. Please try again.",
      }));
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
        <Modal.Title>Providers</Modal.Title>
        <Modal.Description>
          Manage the model providers your assistant can use.
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
        ) : isError ? (
          <Typography
            variant="body-medium-default"
            as="p"
            className="py-4 text-center text-(--system-negative-strong)"
          >
            Failed to load providers. Please try again.
          </Typography>
        ) : connections.length === 0 ? (
          <Typography
            variant="body-medium-lighter"
            as="p"
            className="py-4 text-center text-(--content-tertiary)"
          >
            No providers yet. Add one to get started.
          </Typography>
        ) : (
          <div className="space-y-1">
            {connections.map((conn) => {
              const isDeleting = deleting[conn.name] ?? false;
              const rowError = rowErrors[conn.name];
              const subtitle = providerCardSubtitle(conn);
              const isManaged = conn.isManaged ?? false;
              const isDefault = conn.name === defaultConnectionName;
              const eligibleForDefault = isDefaultProviderId(conn.provider);
              const isSettingDefault =
                setDefault.isPending &&
                setDefault.variables?.body?.connectionName === conn.name;

              return (
                <div key={conn.name}>
                  <div className="flex items-center gap-3 rounded-lg px-2 py-2">
                    {/* Provider info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Typography
                          variant="body-medium-default"
                          as="span"
                          className="text-(--content-default)"
                        >
                          {providerCardTitle(conn)}
                        </Typography>
                        {isManaged && (
                          <Tag
                            tone="positive"
                            title="Managed by Platform — you can rename this provider, but not edit it."
                          >
                            Platform
                          </Tag>
                        )}
                        {isDefault && (
                          <Tag
                            tone="info"
                            title="Built-in profiles (Balanced, Quality, Speed) use this provider."
                          >
                            Default
                          </Tag>
                        )}
                      </div>
                      {subtitle ? (
                        <Typography
                          variant="body-medium-lighter"
                          as="p"
                          className="mt-0.5 text-(--content-tertiary)"
                        >
                          {subtitle}
                        </Typography>
                      ) : null}
                    </div>

                    {/* Actions */}
                    <div className="flex shrink-0 items-center gap-2">
                      {supportsDefaultProvider && !isDefault && (
                        <Button
                          variant="ghost"
                          size="compact"
                          disabled={!eligibleForDefault || isSettingDefault}
                          title={
                            eligibleForDefault
                              ? "Use this provider for the built-in profiles."
                              : "Built-in profiles can't run on this provider."
                          }
                          onClick={() => handleSetDefault(conn)}
                        >
                          Set as default
                        </Button>
                      )}
                      {/* Managed (Vellum) connections are platform-owned:
                          auth is locked and there is nothing user-editable,
                          so they expose no edit affordance. */}
                      {!isManaged && (
                        <Button
                          variant="ghost"
                          size="compact"
                          onClick={() => onEditClick(conn)}
                        >
                          Edit
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="compact"
                        iconOnly={<Trash2 />}
                        aria-label={`Delete ${conn.name}`}
                        disabled={isManaged || isDefault || isDeleting}
                        title={
                          isManaged
                            ? "The Vellum provider cannot be removed"
                            : isDefault
                              ? "This is your default provider. Set another provider as default first."
                              : undefined
                        }
                        onClick={() => void handleDelete(conn.name)}
                        tintColor="var(--system-negative-strong)"
                      />
                    </div>
                  </div>

                  {rowError ? (
                    <Typography
                      variant="body-small-default"
                      as="p"
                      className="px-2 pb-1 text-(--system-negative-strong)"
                    >
                      {rowError}
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
          + Add Provider
        </Button>
        <Button variant="outlined" size="compact" onClick={onClose}>
          Done
        </Button>
      </Modal.Footer>
    </Modal.Content>
  );
}
