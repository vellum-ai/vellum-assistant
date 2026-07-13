import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Loader2,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { credentialsRevealPost } from "@/generated/daemon/sdk.gen";
import { BottomSheet } from "@vellumai/design-library/components/bottom-sheet";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { PanelItem } from "@vellumai/design-library/components/panel-item";
import { Popover } from "@vellumai/design-library/components/popover";
import { toast } from "@vellumai/design-library/components/toast";

/**
 * A locally stored credential row from `POST /v1/credentials/list`. Mirrors the
 * daemon's `buildCredentialOutput` shape for the fields the page renders.
 */
export interface StoredCredential {
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

/** How long the "copied" checkmark stays up after copying a revealed value. */
const COPIED_FEEDBACK_MS = 1500;

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

interface CredentialRowProps {
  credential: StoredCredential;
  /** Assistant whose vault owns this credential — scopes the reveal request. */
  assistantId: string;
  /** Whether one-time credential-request links are enabled for this assistant. */
  canGenerateLink: boolean;
  /** A link is currently being minted for this row. */
  generatingLink: boolean;
  /** This row is currently being deleted. */
  deleting: boolean;
  onGenerateLink: () => void;
  onDelete: () => void;
}

/**
 * Renders a single stored-credential row matching the settings row layout used
 * by integrations and devices: `KeyRound` icon + title/subtitle on the left,
 * and a right-aligned "Configure" menu holding the row actions. The masked
 * secret preview sits on its own line directly beneath the title, above the
 * `service:field · added date` metadata, with an on-demand reveal (see
 * `CredentialValue`).
 *
 * The Configure menu offers:
 *   - "Generate link": mints a one-time credential-request link (feature-gated).
 *   - "Delete":        removes the credential (with confirmation upstream).
 */
export function CredentialRow({
  credential,
  assistantId,
  canGenerateLink,
  generatingLink,
  deleting,
  onGenerateLink,
  onDelete,
}: CredentialRowProps) {
  const name = `${credential.service}:${credential.field}`;
  const [menuOpen, setMenuOpen] = useState(false);
  // Metadata line: the `service:field` (shown only when an alias is the
  // title) and the added date.
  const metadataParts = [
    credential.alias ? name : null,
    credential.createdAt
      ? `added ${formatCreatedAt(credential.createdAt)}`
      : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <Card.Root>
      <Card.Body padding="sm" className="flex items-center gap-4 px-4">
        <KeyRound
          className="h-5 w-5 shrink-0 text-[var(--content-secondary)]"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-title-small text-[var(--content-default)]">
            {credential.alias || name}
          </p>
          <div className="mt-0.5 flex min-w-0 items-center">
            <CredentialValue
              assistantId={assistantId}
              credential={credential}
            />
          </div>
          {metadataParts.length > 0 && (
            <p className="mt-0.5 truncate font-mono text-body-medium-lighter text-[var(--content-tertiary)]">
              {metadataParts.join(" · ")}
            </p>
          )}
        </div>
        <div className="shrink-0">
          <CredentialConfigureMenu
            name={name}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            canGenerateLink={canGenerateLink}
            generatingLink={generatingLink}
            deleting={deleting}
            onGenerateLink={() => {
              setMenuOpen(false);
              onGenerateLink();
            }}
            onDelete={() => {
              setMenuOpen(false);
              onDelete();
            }}
          />
        </div>
      </Card.Body>
    </Card.Root>
  );
}

// ---------------------------------------------------------------------------
// CredentialValue — masked/revealed secret preview for a single stored
// credential. Owns its own reveal + copy state so the row stays a thin
// orchestrator. The masked preview (`****last4`) is rendered blurred until the
// user reveals it, at which point the plaintext is fetched on demand via
// `POST /v1/credentials/reveal` — the value is never held in the list query
// cache, only in this component's transient state, and is dropped on re-hide.
// ---------------------------------------------------------------------------

function CredentialValue({
  assistantId,
  credential,
}: {
  assistantId: string;
  credential: StoredCredential;
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

  // Metadata-only rows (e.g. transient credential prompts or OAuth entries)
  // have no storable secret — `hasSecret` is false and the reveal handler can
  // only return "Credential not found". Render the inert scrubbed preview
  // (typically "(not set)") without any reveal/copy affordances.
  if (!credential.hasSecret) {
    return (
      <span className="min-w-0 truncate font-mono text-body-medium-lighter text-[var(--content-tertiary)]">
        {credential.scrubbedValue}
      </span>
    );
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 align-middle font-mono text-body-medium-lighter">
      <button
        type="button"
        onClick={() => (isRevealed ? hide() : void reveal())}
        disabled={isRevealing}
        aria-label={
          isRevealed ? `Hide value for ${name}` : `Reveal value for ${name}`
        }
        title={isRevealed ? "Hide value" : "Click to reveal"}
        // Prevent session-replay (LogRocket) from recording the credential
        // value. The attribute is always present so the masked preview
        // (****last4) is also excluded, not just the revealed plaintext.
        // https://docs.logrocket.com/reference/dom#sanitizing-individual-elements
        data-private
        className={`min-w-0 truncate rounded-sm text-left transition-[filter,color] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] ${
          isRevealed
            ? "text-[var(--content-secondary)]"
            : "select-none text-[var(--content-tertiary)] blur-[3px] hover:blur-[2px]"
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

// ---------------------------------------------------------------------------
// CredentialConfigureMenu — desktop popover / mobile bottom-sheet wrapper for
// the stored-credential "Configure" action menu. Unit-testable in isolation
// (no parent mutations required), mirroring IntegrationConfigureMenu.
// ---------------------------------------------------------------------------

export interface CredentialConfigureMenuProps {
  /** `service:field` of the credential — used as the mobile sheet title. */
  name: string;
  /** Whether the Configure menu is open (controlled). */
  open: boolean;
  onOpenChange: (next: boolean) => void;
  canGenerateLink: boolean;
  generatingLink: boolean;
  deleting: boolean;
  onGenerateLink: () => void;
  onDelete: () => void;
}

export function CredentialConfigureMenu({
  name,
  open,
  onOpenChange,
  canGenerateLink,
  generatingLink,
  deleting,
  onGenerateLink,
  onDelete,
}: CredentialConfigureMenuProps) {
  const isMobile = useIsMobile();
  const busy = generatingLink || deleting;

  const trigger = (
    <Button
      variant="outlined"
      rightIcon={<ChevronDown />}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Configure ${name}`}
      leftIcon={
        busy ? <Loader2 className="animate-spin" aria-hidden /> : undefined
      }
    >
      Configure
    </Button>
  );

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
        <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
        <BottomSheet.Content>
          {/* Use the credential name as the (visible) sheet title so the user
              has a clear anchor for which credential they're acting on. */}
          <BottomSheet.Header>
            <BottomSheet.Title>{name}</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body>
            {canGenerateLink && (
              <PanelItem
                icon={generatingLink ? Loader2 : Link2}
                label="Generate link"
                onSelect={() => {
                  if (busy) {
                    return;
                  }
                  onGenerateLink();
                }}
              />
            )}
            <PanelItem
              icon={deleting ? Loader2 : Trash2}
              label="Delete"
              onSelect={() => {
                if (busy) {
                  return;
                }
                onDelete();
              }}
            />
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Content
        align="end"
        sideOffset={4}
        role="menu"
        className="w-56 overflow-hidden p-0"
      >
        {canGenerateLink && (
          <Button
            type="button"
            role="menuitem"
            variant="ghost"
            onClick={onGenerateLink}
            disabled={busy}
            className="w-full justify-start rounded-none"
            leftIcon={
              generatingLink ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Link2 aria-hidden />
              )
            }
          >
            Generate link
          </Button>
        )}
        <Button
          type="button"
          role="menuitem"
          variant="dangerGhost"
          onClick={onDelete}
          disabled={busy}
          className="w-full justify-start rounded-none"
          leftIcon={
            deleting ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Trash2 aria-hidden />
            )
          }
        >
          Delete
        </Button>
      </Popover.Content>
    </Popover.Root>
  );
}
