/**
 * Inline chip for redacted-credential sentinels in chat transcripts
 * (LUM-2768).
 *
 * The daemon persists detected secrets as sentinels (see
 * `rehype-redacted-credential.ts`), which reach this component in two
 * shapes:
 *
 * - **Enriched** (`service` + `field` present): the daemon byte-matched the
 *   redacted span to a stored credential at persist time, so the chip offers
 *   click-to-reveal — the plaintext is re-fetched from the vault on demand
 *   and never persisted. Mirrors the settings-page `CredentialValue`
 *   interaction (blur → reveal → copy/hide) with the same stale-response
 *   guard.
 * - **Plain** (type only): the secret could not be proven to be any stored
 *   credential (hand-typed keys, parse failures, value drift). Renders a
 *   static badge — by design there is nothing to reveal, and no fuzzy
 *   fallback is attempted.
 *
 * Interaction duplicated from `credentials-page.tsx` (#37931) rather than
 * extracted while that PR is still in review; unify into a shared primitive
 * once it lands.
 */

import { Check, Copy, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { credentialsRevealPost } from "@/generated/daemon/sdk.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { toast } from "@vellumai/design-library/components/toast";

const COPIED_FEEDBACK_MS = 1500;

const CHIP_CLASS =
  "inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-[var(--border-default)] bg-[var(--surface-secondary)] px-1.5 py-0.5 align-middle text-[0.85em] leading-tight text-[var(--content-secondary)]";

const ICON_BUTTON_CLASS =
  "shrink-0 rounded-sm p-0.5 text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]";

export interface RedactedCredentialChipProps {
  /** Secret type label from the scanner, e.g. "Anthropic API Key". */
  type?: string;
  /** Vault service namespace — present only on enriched sentinels. */
  service?: string;
  /** Vault field name — present only on enriched sentinels. */
  field?: string;
}

export function RedactedCredentialChip({
  type,
  service,
  field,
}: RedactedCredentialChipProps) {
  // Raw nullable read on purpose: transcripts render on pre-active paths
  // (ChatPage loading/connecting) outside `ActiveAssistantGate`, where the
  // throwing `useActiveAssistantId()` would crash the view. A null id simply
  // renders the non-revealable badge until the assistant is active.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [isRevealing, setIsRevealing] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Monotonic token used to ignore stale reveal responses: an in-flight
  // request superseded by a newer reveal or a hide is silently dropped
  // instead of overwriting newer state with an obsolete secret.
  const revealVersionRef = useRef(0);

  const label = type ?? "Secret";
  const revealable =
    service !== undefined && field !== undefined && assistantId != null;
  const name = revealable ? `${service}:${field}` : label;

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

  const reveal = useCallback(async () => {
    if (!revealable) {
      return;
    }
    const myVersion = ++revealVersionRef.current;
    setIsRevealing(true);
    try {
      const { data } = await credentialsRevealPost({
        path: { assistant_id: assistantId },
        body: { service, field },
        throwOnError: true,
      });
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
  }, [revealable, assistantId, service, field, name]);

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

  // Plain sentinel (or no assistant context): static badge, nothing to
  // reveal. The value was redacted at persist time and is not recoverable.
  if (!revealable) {
    return (
      <span
        className={CHIP_CLASS}
        title="Redacted — this value is not linked to a stored credential"
      >
        <KeyRound className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
    );
  }

  const isRevealed = revealed !== null;

  return (
    <span className={CHIP_CLASS}>
      <KeyRound className="h-3 w-3 shrink-0" aria-hidden />
      {isRevealed ? (
        <span className="min-w-0 truncate font-mono text-[var(--content-default)]">
          {revealed}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => void reveal()}
          disabled={isRevealing}
          aria-label={`Reveal value for ${name}`}
          title={`${label} · click to reveal`}
          className="min-w-0 select-none truncate rounded-sm text-left blur-[3px] transition-[filter] hover:blur-[2px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]"
        >
          {name}
        </button>
      )}
      {isRevealing ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
      ) : isRevealed ? (
        <>
          <button
            type="button"
            onClick={copy}
            aria-label={`Copy value for ${name}`}
            title="Copy value"
            className={ICON_BUTTON_CLASS}
          >
            {justCopied ? (
              <Check className="h-3 w-3" aria-hidden />
            ) : (
              <Copy className="h-3 w-3" aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={hide}
            aria-label={`Hide value for ${name}`}
            title="Hide value"
            className={ICON_BUTTON_CLASS}
          >
            <EyeOff className="h-3 w-3" aria-hidden />
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void reveal()}
          disabled={isRevealing}
          aria-label={`Reveal value for ${name}`}
          title="Click to reveal"
          className={ICON_BUTTON_CLASS}
        >
          <Eye className="h-3 w-3" aria-hidden />
        </button>
      )}
    </span>
  );
}
