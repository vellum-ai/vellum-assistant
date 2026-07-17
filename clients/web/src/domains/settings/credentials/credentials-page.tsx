import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Link2, Loader2, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DetailCard } from "@/components/detail-card";
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
import { Modal } from "@vellumai/design-library/components/modal";
import {
  SegmentControl,
  type SegmentControlItem,
} from "@vellumai/design-library/components/segment-control";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";

import { CredentialRow, type StoredCredential } from "./credential-row";
import {
  createCredentialRequest,
  credentialRequestExpiryToEpochMs,
} from "./credential-requests-api";

/** A platform-managed credential from the credentials list. Read-only. */
interface ManagedCredentialRow {
  handle: string;
  provider: string;
  accountInfo: string | null;
  status: string;
}

/** A freshly minted one-time credential-request link, shown in a modal. */
interface GeneratedLink {
  /** `service:field` of the credential the link fills. */
  name: string;
  url: string;
  /** Epoch (seconds or ms) the link expires at, when the daemon reports it. */
  expiresAt: number | null;
}

function credentialsListQueryKey(assistantId: string) {
  return ["credentials-list", assistantId] as const;
}

/** Below this count, scanning the list beats typing — so we hide the search. */
const SEARCH_VISIBILITY_THRESHOLD = 6;

/** Which credential group the segment control is showing. */
type CredentialView = "own" | "managed";

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
  const credentialRequestsEnabled =
    useAssistantFeatureFlagStore.use.credentialRequests();

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
        credentials: data.credentials as StoredCredential[],
        managedCredentials: data.managedCredentials as ManagedCredentialRow[],
      };
    },
    enabled: isOrgReady,
    retry: shouldRetryDaemonError,
  });

  const credentials = useMemo(
    () => listQuery.data?.credentials ?? [],
    [listQuery.data],
  );
  const managedCredentials = useMemo(
    () => listQuery.data?.managedCredentials ?? [],
    [listQuery.data],
  );

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
  const [credentialView, setCredentialView] = useState<CredentialView>("own");
  const [searchText, setSearchText] = useState("");
  const [service, setService] = useState("");
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [pendingDeletion, setPendingDeletion] =
    useState<StoredCredential | null>(null);
  const [generatedLink, setGeneratedLink] = useState<GeneratedLink | null>(
    null,
  );
  const [generatingLinkName, setGeneratingLinkName] = useState<string | null>(
    null,
  );

  const saving = setMutation.isPending;
  const deletingName = deleteMutation.isPending
    ? `${deleteMutation.variables?.body?.service}:${deleteMutation.variables?.body?.field}`
    : null;

  const filteredCredentials = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    if (!needle) {
      return credentials;
    }
    return credentials.filter((credential) => {
      const haystack = [
        credential.service,
        credential.field,
        `${credential.service}:${credential.field}`,
        credential.alias ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [credentials, searchText]);

  // When the list shrinks below the search threshold the input is unmounted, so
  // an in-progress query would keep filtering invisibly with no way to clear it.
  // Reset the text whenever search is hidden to avoid a stale, un-clearable filter.
  useEffect(() => {
    if (credentials.length <= SEARCH_VISIBILITY_THRESHOLD) {
      setSearchText("");
    }
  }, [credentials.length]);

  // When the own credential list is empty but managed credentials exist, default
  // to the Managed tab so users see their credentials instead of an empty state.
  // The user can still switch to "Your own" to add one — this only fires when the
  // data changes, not on every view toggle.
  useEffect(() => {
    if (credentials.length === 0 && managedCredentials.length > 0) {
      setCredentialView("managed");
    }
  }, [credentials.length, managedCredentials.length]);

  // --- Handlers ---

  const resetAddForm = () => {
    setIsShowingAddForm(false);
    setService("");
    setField("");
    setValue("");
    setLabel("");
  };

  const handleSave = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmedService = service.trim();
    const trimmedField = field.trim();
    // The secret value is stored verbatim — some secrets legitimately carry
    // leading/trailing whitespace, and the CLI set path stores them unchanged.
    // Trimming is used only to reject effectively-empty input.
    if (!trimmedService || !trimmedField || !value.trim()) {
      return;
    }
    setMutation.mutate(
      {
        path: { assistant_id: assistantId },
        body: {
          service: trimmedService,
          field: trimmedField,
          value,
          label: label.trim() || undefined,
        },
      },
      { onSuccess: resetAddForm },
    );
  };

  const confirmDelete = () => {
    const credential = pendingDeletion;
    setPendingDeletion(null);
    if (!credential) {
      return;
    }
    deleteMutation.mutate(
      {
        path: { assistant_id: assistantId },
        body: { service: credential.service, field: credential.field },
      },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: listQueryKey });
          toast.success(`Deleted ${credential.service}:${credential.field}.`);
        },
      },
    );
  };

  const handleGenerateLink = async (credential: StoredCredential) => {
    const name = `${credential.service}:${credential.field}`;
    setGeneratingLinkName(name);
    try {
      const result = await createCredentialRequest(assistantId, {
        service: credential.service,
        field: credential.field,
        label: credential.alias ?? undefined,
      });
      if (result.ok && result.url) {
        setGeneratedLink({
          name,
          url: result.url,
          expiresAt: result.expiresAt ?? null,
        });
      } else {
        toast.error(result.error || "Failed to generate a one-time link");
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to generate a one-time link",
      );
    } finally {
      setGeneratingLinkName(null);
    }
  };

  const handleCopyGeneratedLink = () => {
    const url = generatedLink?.url;
    if (!url) {
      return;
    }
    void navigator.clipboard.writeText(url).then(
      () => toast.success("Link copied to clipboard."),
      () =>
        toast.error("Couldn't copy the link — select it and copy manually."),
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

  const hasCredentials = credentials.length > 0;
  const hasManaged = managedCredentials.length > 0;

  // Search stays hidden for short lists where scanning is faster than typing;
  // it only earns its place once the list is long enough to get unwieldy.
  const showSearch = credentials.length > SEARCH_VISIBILITY_THRESHOLD;

  const showManaged = credentialView === "managed" && hasManaged;
  const showOwn = !showManaged;
  const segmentItems: SegmentControlItem<CredentialView>[] = [
    { value: "own", label: "Your own" },
    { value: "managed", label: "Managed" },
  ];

  return (
    <div className="space-y-4">
      <DetailCard
        title="Credentials"
        subtitle={
          showManaged
            ? "Provided through your Vellum-managed integrations. These are read-only here."
            : "Stored encrypted in your assistant's credential vault. Reveal a value on demand, or replace or delete it at any time."
        }
        accessory={
          <div className="flex items-center gap-2">
            {hasManaged ? (
              <SegmentControl
                items={segmentItems}
                value={credentialView}
                onChange={setCredentialView}
                ariaLabel="Credential source"
              />
            ) : null}
            {showOwn && hasCredentials ? (
              <Button
                type="button"
                variant="primary"
                size="regular"
                onClick={() => setIsShowingAddForm(true)}
                leftIcon={<Plus aria-hidden />}
              >
                Add
              </Button>
            ) : null}
          </div>
        }
      >
        {showManaged ? (
          <div className="space-y-2">
            {managedCredentials.map((managed) => (
              <Card.Root key={managed.handle}>
                <Card.Body
                  padding="sm"
                  className="flex items-center gap-4 px-4"
                >
                  <KeyRound
                    className="h-5 w-5 shrink-0 text-[var(--content-secondary)]"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-title-small text-[var(--content-default)]">
                      {managed.provider}
                    </p>
                    <p className="truncate text-body-medium-lighter text-[var(--content-tertiary)]">
                      {managed.accountInfo ?? managed.handle} · {managed.status}
                    </p>
                  </div>
                  <Tag tone="neutral">Managed</Tag>
                </Card.Body>
              </Card.Root>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            {hasCredentials ? (
              <div className="space-y-3">
                {showSearch ? (
                  <Input
                    type="text"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    placeholder="Search credentials"
                    aria-label="Search credentials"
                    leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
                    fullWidth
                  />
                ) : null}
                {filteredCredentials.length === 0 ? (
                  <p className="px-1 py-2 text-body-medium-lighter text-[var(--content-tertiary)]">
                    No credentials matched &ldquo;{searchText.trim()}&rdquo;.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {filteredCredentials.map((credential) => {
                      const name = `${credential.service}:${credential.field}`;
                      return (
                        <CredentialRow
                          key={credential.credentialId ?? name}
                          credential={credential}
                          assistantId={assistantId}
                          canGenerateLink={credentialRequestsEnabled}
                          generatingLink={generatingLinkName === name}
                          deleting={deletingName === name}
                          onGenerateLink={() =>
                            void handleGenerateLink(credential)
                          }
                          onDelete={() => setPendingDeletion(credential)}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-base)]">
                  <KeyRound
                    className="h-6 w-6 text-[var(--content-disabled)] dark:text-[var(--content-default)]"
                    aria-hidden
                  />
                </div>
                <h3 className="mt-4 text-title-small text-[var(--content-default)]">
                  No credentials yet
                </h3>
                <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
                  Add an API key or token to let tools and integrations use it.
                </p>
              </div>
            )}

            {hasCredentials ? null : (
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
          </div>
        )}
      </DetailCard>

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

      <Modal.Root
        open={isShowingAddForm}
        onOpenChange={(open) => {
          // Ignore dismissal (Escape / backdrop) while a save is in flight so a
          // slow or failing mutation can't discard the entered secret, which
          // the user may not be able to recover. The form clears only once the
          // mutation settles (resetAddForm runs on success and on explicit
          // Cancel, which is itself disabled while saving).
          if (!open && !saving) {
            resetAddForm();
          }
        }}
      >
        <Modal.Content size="sm">
          <form onSubmit={handleSave}>
            <Modal.Header>
              <Modal.Title icon={KeyRound}>Add credential</Modal.Title>
              <Modal.Description>
                Add an API key or token to let tools and integrations use it.
              </Modal.Description>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input
                  label="Service"
                  type="text"
                  value={service}
                  onChange={(e) => setService(e.target.value)}
                  placeholder="e.g. github"
                  autoFocus
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
            </Modal.Body>
            <Modal.Footer>
              <Button
                type="button"
                variant="outlined"
                onClick={resetAddForm}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  saving || !service.trim() || !field.trim() || !value.trim()
                }
                leftIcon={
                  saving ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : undefined
                }
              >
                Save
              </Button>
            </Modal.Footer>
          </form>
        </Modal.Content>
      </Modal.Root>

      <Modal.Root
        open={generatedLink !== null}
        onOpenChange={(open) => {
          if (!open) {
            setGeneratedLink(null);
          }
        }}
      >
        <Modal.Content size="sm">
          <Modal.Header>
            <Modal.Title icon={Link2}>One-time credential link</Modal.Title>
            <Modal.Description>
              {generatedLink
                ? `Send this link to whoever should provide ${generatedLink.name}. It works exactly once${
                    generatedLink.expiresAt !== null
                      ? ` and expires ${new Date(
                          credentialRequestExpiryToEpochMs(
                            generatedLink.expiresAt,
                          ),
                        ).toLocaleString()}`
                      : ""
                  }. Anyone with the link can set this credential, so share it over a trusted channel.`
                : ""}
            </Modal.Description>
          </Modal.Header>
          <Modal.Body>
            <Input
              label="Link"
              type="text"
              readOnly
              value={generatedLink?.url ?? ""}
              onFocus={(e) => e.currentTarget.select()}
              fullWidth
            />
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="button"
              size="compact"
              onClick={handleCopyGeneratedLink}
              leftIcon={<Copy aria-hidden />}
            >
              Copy link
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </div>
  );
}
