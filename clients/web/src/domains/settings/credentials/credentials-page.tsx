import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { NotFound } from "@/components/not-found";
import {
  useCredentialsDeletePostMutation,
  useCredentialsSetPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { credentialsListPost } from "@/generated/daemon/sdk.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Input } from "@vellumai/design-library/components/input";
import { toast } from "@vellumai/design-library/components/toast";

/**
 * A locally stored credential row from `POST /v1/credentials/list`. The route's
 * response schema types entries as unknown; this mirrors the daemon's
 * `buildCredentialOutput` shape for the fields the page renders.
 */
interface CredentialRow {
  service: string;
  field: string;
  credentialId: string | null;
  scrubbedValue: string;
  hasSecret: boolean;
  alias: string | null;
  usageDescription: string | null;
  createdAt: string | null;
}

/** A platform-managed credential from the same response. Read-only. */
interface ManagedCredentialRow {
  handle: string;
  provider: string;
  accountInfo: string | null;
  status: string;
}

function credentialsListQueryKey(assistantId: string) {
  return ["credentials-list", assistantId] as const;
}

function formatCreatedAt(iso: string | null): string {
  if (!iso) {return "";}
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

export function CredentialsPage() {
  const credentialsSettingsEnabled =
    useAssistantFeatureFlagStore.use.credentialsSettings();
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();

  if (flagsHydrated && !credentialsSettingsEnabled) {
    return <NotFound />;
  }
  if (!flagsHydrated) {
    return null;
  }
  return <CredentialsPageInner />;
}

function CredentialsPageInner() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const isOrgReady = useIsOrgReady();

  const listQueryKey = credentialsListQueryKey(assistantId);
  const listQuery = useQuery({
    queryKey: listQueryKey,
    queryFn: async () => {
      const { data } = await credentialsListPost({
        path: { assistant_id: assistantId },
        body: {},
        throwOnError: true,
      });
      return {
        credentials: data.credentials as CredentialRow[],
        managedCredentials: data.managedCredentials as ManagedCredentialRow[],
      };
    },
    enabled: isOrgReady,
    retry: shouldRetryDaemonError,
  });

  const credentials = listQuery.data?.credentials ?? [];
  const managedCredentials = listQuery.data?.managedCredentials ?? [];

  const setMutation = useCredentialsSetPostMutation({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listQueryKey });
      toast.success("Credential saved.");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to save credential");
    },
  });

  const deleteMutation = useCredentialsDeletePostMutation({
    onError: (err) => {
      toast.error(err.message || "Failed to delete credential");
    },
  });

  // --- Ephemeral UI state ---

  const [isShowingAddForm, setIsShowingAddForm] = useState(false);
  const [service, setService] = useState("");
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [pendingDeletion, setPendingDeletion] = useState<CredentialRow | null>(
    null,
  );

  const saving = setMutation.isPending;
  const deletingName = deleteMutation.isPending
    ? `${deleteMutation.variables?.body?.service}:${deleteMutation.variables?.body?.field}`
    : null;

  // --- Handlers ---

  const resetAddForm = () => {
    setIsShowingAddForm(false);
    setService("");
    setField("");
    setValue("");
    setLabel("");
  };

  const handleSave = () => {
    const trimmedService = service.trim();
    const trimmedField = field.trim();
    const trimmedValue = value.trim();
    if (!trimmedService || !trimmedField || !trimmedValue) {return;}
    setMutation.mutate(
      {
        path: { assistant_id: assistantId },
        body: {
          service: trimmedService,
          field: trimmedField,
          value: trimmedValue,
          label: label.trim() || undefined,
        },
      },
      { onSuccess: resetAddForm },
    );
  };

  const confirmDelete = () => {
    const credential = pendingDeletion;
    setPendingDeletion(null);
    if (!credential) {return;}
    deleteMutation.mutate(
      {
        path: { assistant_id: assistantId },
        body: { service: credential.service, field: credential.field },
      },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: listQueryKey });
          toast.success(
            `Deleted ${credential.service}:${credential.field}.`,
          );
        },
      },
    );
  };

  // --- Render ---

  if (listQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--content-disabled)]" />
      </div>
    );
  }

  const shouldShowForm = isShowingAddForm || credentials.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-small-default leading-relaxed text-[var(--content-tertiary)]">
        Credentials are stored encrypted on your assistant and are never sent
        to Vellum. Values are write-only — they can be replaced or deleted, but
        not viewed here.
      </p>

      {credentials.length > 0 ? (
        <Card.Root>
          <Card.Body className="flex flex-col divide-y divide-[var(--border-default)]">
            {credentials.map((credential) => {
              const name = `${credential.service}:${credential.field}`;
              return (
                <div
                  key={credential.credentialId ?? name}
                  className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <KeyRound
                    className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body-medium-default text-[var(--content-default)]">
                      {credential.alias || name}
                    </p>
                    <p className="truncate font-mono text-body-small-default text-[var(--content-tertiary)]">
                      {credential.alias ? `${name} · ` : ""}
                      {credential.scrubbedValue}
                      {credential.createdAt
                        ? ` · added ${formatCreatedAt(credential.createdAt)}`
                        : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    onClick={() => setPendingDeletion(credential)}
                    disabled={deletingName === name}
                    aria-label={`Delete ${name}`}
                    iconOnly={
                      deletingName === name ? (
                        <Loader2 className="animate-spin" aria-hidden />
                      ) : (
                        <Trash2 aria-hidden />
                      )
                    }
                  />
                </div>
              );
            })}
          </Card.Body>
        </Card.Root>
      ) : null}

      {shouldShowForm ? (
        <Card.Root>
          <Card.Body className="flex flex-col gap-3">
            <p className="text-body-medium-default text-[var(--content-default)]">
              {credentials.length === 0
                ? "Add a credential"
                : "Add another credential"}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input
                label="Service"
                type="text"
                value={service}
                onChange={(e) => setService(e.target.value)}
                placeholder="e.g. github"
                fullWidth
              />
              <Input
                label="Field"
                type="text"
                value={field}
                onChange={(e) => setField(e.target.value)}
                placeholder="e.g. api_token"
                fullWidth
              />
            </div>
            <Input
              label="Value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter the secret value"
              fullWidth
            />
            <Input
              label="Label (optional)"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. GitHub personal access token"
              fullWidth
            />
            <div className="flex items-center justify-end gap-2 pt-1">
              {credentials.length > 0 ? (
                <Button
                  type="button"
                  variant="outlined"
                  size="compact"
                  onClick={resetAddForm}
                  disabled={saving}
                >
                  Cancel
                </Button>
              ) : null}
              <Button
                type="button"
                size="compact"
                onClick={handleSave}
                disabled={
                  saving || !service.trim() || !field.trim() || !value.trim()
                }
                leftIcon={
                  saving ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : undefined
                }
              >
                Save Credential
              </Button>
            </div>
          </Card.Body>
        </Card.Root>
      ) : (
        <Button
          type="button"
          variant="outlined"
          size="compact"
          onClick={() => setIsShowingAddForm(true)}
          className="w-full border-dashed"
          leftIcon={<Plus aria-hidden />}
        >
          Add Credential
        </Button>
      )}

      {managedCredentials.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-body-small-default text-[var(--content-secondary)]">
            Managed by Vellum
          </p>
          <Card.Root>
            <Card.Body className="flex flex-col divide-y divide-[var(--border-default)]">
              {managedCredentials.map((managed) => (
                <div
                  key={managed.handle}
                  className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <KeyRound
                    className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body-medium-default text-[var(--content-default)]">
                      {managed.provider}
                    </p>
                    <p className="truncate text-body-small-default text-[var(--content-tertiary)]">
                      {managed.accountInfo ?? managed.handle} ·{" "}
                      {managed.status}
                    </p>
                  </div>
                </div>
              ))}
            </Card.Body>
          </Card.Root>
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingDeletion !== null}
        title="Delete credential"
        message={
          pendingDeletion
            ? `Delete ${pendingDeletion.service}:${pendingDeletion.field}? Tools and integrations using it will lose access.`
            : ""
        }
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeletion(null)}
      />
    </div>
  );
}
