import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { NotFound } from "@/components/not-found";
import {
  useCredentialsDeletePostMutation,
  useCredentialsSetPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  credentialsListPost,
  credentialsRevealPost,
} from "@/generated/daemon/sdk.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";

import {
  createCredentialRequest,
  credentialRequestExpiryToEpochMs,
} from "./credential-requests-api";

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
  updatedAt: string | null;
}

/** A platform-managed credential from the same response. Read-only. */
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

function formatCreatedAt(iso: string | null): string {
  if (!iso) {
    return "";
  }
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

/** How long the "copied" checkmark stays up after copying a revealed value. */
const COPIED_FEEDBACK_MS = 1500;

/**
 * The masked/revealed secret preview for a single local credential row.
 *
 * Owns its own reveal + copy state so the parent stays a thin orchestrator.
 * The masked preview (`****last4`) is rendered blurred until the user reveals
 * it, at which point the plaintext is fetched on demand via
 * `POST /v1/credentials/reveal` — the value is never held in the list query
 * cache, only in this component's transient state, and is dropped on re-hide.
 */
function CredentialValue({
  assistantId,
  credential,
}: {
  assistantId: string;
  credential: CredentialRow;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [isRevealing, setIsRevealing] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Monotonic token used to ignore stale reveal responses. Incremented on
  // every reveal, hide, and credential change so that an in-flight promise
  // whose row has since changed (or been hidden) is silently dropped instead
  // of overwriting newer state with an obsolete secret.
  const revealVersionRef = useRef(0);

  const name = `${credential.service}:${credential.field}`;

  const hide = useCallback(() => {
    revealVersionRef.current++;
    setRevealed(null);
    setIsRevealing(false);
    setJustCopied(false);
    if (copiedTimer.current) {
      clearTimeout(copiedTimer.current);
      copiedTimer.current = null;
    }
  }, []);

  // Clear any revealed plaintext when the underlying secret changes (e.g. the
  // user replaces the credential via the form). The row key stays stable for
  // an upsert, so without this the stale plaintext from the previous value
  // would remain visible and copyable until the row remounts. Using
  // `updatedAt` (not `scrubbedValue`) avoids a false negative when the
  // replacement masks to the same preview (e.g. same last four chars or any
  // value ≤ 4 chars where scrubSecret() returns "****").
  useEffect(() => {
    hide();
  }, [credential.updatedAt, hide]);

  const reveal = useCallback(async () => {
    const myVersion = ++revealVersionRef.current;
    setIsRevealing(true);
    try {
      const { data } = await credentialsRevealPost({
        path: { assistant_id: assistantId },
        body: { service: credential.service, field: credential.field },
        throwOnError: true,
      });
      // Only apply the result if no newer reveal, hide, or credential change
      // has superseded this request.
      if (revealVersionRef.current === myVersion) {
        setRevealed(data.value);
      }
    } catch {
      if (revealVersionRef.current === myVersion) {
        toast.error(`Couldn't reveal ${name}.`);
      }
    } finally {
      if (revealVersionRef.current === myVersion) {
        setIsRevealing(false);
      }
    }
  }, [assistantId, credential.service, credential.field, name]);

  const copy = useCallback(() => {
    if (revealed == null) {
      return;
    }
    void navigator.clipboard.writeText(revealed).then(
      () => {
        setJustCopied(true);
        if (copiedTimer.current) {
          clearTimeout(copiedTimer.current);
        }
        copiedTimer.current = setTimeout(
          () => setJustCopied(false),
          COPIED_FEEDBACK_MS,
        );
      },
      () => toast.error("Couldn't copy — reveal and copy manually."),
    );
  }, [revealed]);

  const isRevealed = revealed !== null;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 align-middle">
      <button
        type="button"
        onClick={() => (isRevealed ? hide() : void reveal())}
        disabled={isRevealing}
        aria-label={
          isRevealed ? `Hide value for ${name}` : `Reveal value for ${name}`
        }
        title={isRevealed ? "Hide value" : "Click to reveal"}
        className={`min-w-0 truncate rounded-sm text-left transition-[filter,color] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] ${
          isRevealed
            ? "text-[var(--content-secondary)]"
            : "select-none blur-[3px] hover:blur-[2px]"
        }`}
      >
        {isRevealed ? revealed : credential.scrubbedValue}
      </button>
      {isRevealing ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
      ) : isRevealed ? (
        <>
          <button
            type="button"
            onClick={copy}
            aria-label={`Copy value for ${name}`}
            title="Copy value"
            className="shrink-0 rounded-sm p-0.5 text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]"
          >
            {justCopied ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={hide}
            aria-label={`Hide value for ${name}`}
            title="Hide value"
            className="shrink-0 rounded-sm p-0.5 text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]"
          >
            <EyeOff className="h-3.5 w-3.5" aria-hidden />
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void reveal()}
          aria-label={`Reveal value for ${name}`}
          title="Click to reveal"
          className="shrink-0 rounded-sm p-0.5 text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]"
        >
          <Eye className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </span>
  );
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

  const handleGenerateLink = async (credential: CredentialRow) => {
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

  const shouldShowForm = isShowingAddForm || credentials.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-small-default leading-relaxed text-[var(--content-tertiary)]">
        Credentials are stored encrypted in your assistant&apos;s credential
        vault. Values stay masked — click a value to reveal it, or replace and
        delete them here.
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
                    <div className="flex min-w-0 items-center gap-1.5 font-mono text-body-small-default text-[var(--content-tertiary)]">
                      {credential.alias ? (
                        <span className="shrink-0">{name} ·</span>
                      ) : null}
                      <CredentialValue
                        assistantId={assistantId}
                        credential={credential}
                      />
                      {credential.createdAt ? (
                        <span className="shrink-0 truncate">
                          · added {formatCreatedAt(credential.createdAt)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {credentialRequestsEnabled ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="compact"
                      onClick={() => void handleGenerateLink(credential)}
                      disabled={generatingLinkName === name}
                      aria-label={`Generate one-time link for ${name}`}
                      title="Generate one-time link"
                      iconOnly={
                        generatingLinkName === name ? (
                          <Loader2 className="animate-spin" aria-hidden />
                        ) : (
                          <Link2 aria-hidden />
                        )
                      }
                    />
                  ) : null}
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
                      {managed.accountInfo ?? managed.handle} · {managed.status}
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
