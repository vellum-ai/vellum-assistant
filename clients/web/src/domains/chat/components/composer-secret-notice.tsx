import { Button, Notice } from "@vellumai/design-library";
import type { DetectedSecret } from "@vellumai/service-contracts/secret-detection";

import { isStorableSecret } from "@/domains/chat/components/store-credential-dialog";

/** Leading characters of the detected value kept visible in the masked preview. */
const MASK_VISIBLE_CHARS = 6;
const MASK_BULLETS = "•".repeat(8);

/**
 * Masked preview of a detected secret: a short recognizable head plus a
 * fixed bullet tail — never the full value.
 */
export function maskSecretValue(value: string): string {
  return `${value.slice(0, MASK_VISIBLE_CHARS)}${MASK_BULLETS}`;
}

export interface ComposerSecretNoticeProps {
  /** Detected secrets ordered by draft position; the first is previewed. */
  matches: DetectedSecret[];
  /**
   * True when the pre-send gate intercepted the last submit. Switches the
   * notice from the passive warning to the blocked-send state with explicit
   * actions.
   */
  sendBlocked: boolean;
  /** Invoked when the user dismisses the warning. */
  onDismiss: () => void;
  /**
   * Blocked state only: the user explicitly chose to send despite the
   * warning. The orchestrator arms the detection hook's single-use
   * `allowOnce()` bypass and re-invokes the composer submit handler with
   * the daemon's per-message `bypassSecretCheck` override.
   */
  onSendAnyway: () => void;
  /**
   * Both states: opens the store-credential dialog for the previewed
   * (first) detected secret so the user can vault it and have the draft
   * rewritten instead of sending the plaintext key.
   */
  onStoreSecurely: () => void;
}

/**
 * Warning above the composer when the draft contains what looks like an API
 * key. Two states:
 *
 * - Passive (`sendBlocked` false): informational warning with a dismiss
 *   control, shown while typing.
 * - Blocked (`sendBlocked` true): the pre-send gate intercepted a submit;
 *   the draft is untouched and the user chooses "Send anyway" (single-use
 *   bypass + resubmit) or "Dismiss".
 *
 * Both states lead with "Store securely" — the recommended path — which
 * opens the store-credential dialog for the previewed secret. The action is
 * omitted for a non-storable match (see {@link isStorableSecret}).
 *
 * The copy is deliberately generic — the detection label (which names the
 * vendor) stays internal and is never rendered. The detected value appears
 * masked only; the full plaintext never reaches the DOM.
 *
 * "Send anyway" is honored end to end: the orchestrator's handler arms the
 * detection hook's content-bound single-use bypass and resubmits with the
 * daemon's per-message `bypassSecretCheck` override, so the explicit
 * confirmation clears both the client gate and the daemon's
 * `secret_blocked` ingress guard.
 */
export function ComposerSecretNotice({
  matches,
  sendBlocked,
  onDismiss,
  onSendAnyway,
  onStoreSecurely,
}: ComposerSecretNoticeProps) {
  const first = matches[0];
  if (!first) {
    return null;
  }
  // A non-storable match (a private key detected by its header alone — the
  // END footer never arrived) gets no "Store securely" action: the store +
  // rewrite would remove only the header and leave the key body behind.
  const storeSecurelyButton = isStorableSecret(first) ? (
    <Button variant="primary" size="compact" onClick={onStoreSecurely}>
      Store securely
    </Button>
  ) : null;
  return (
    <div className="mb-2">
      <Notice
        tone="warning"
        title={
          sendBlocked
            ? "Message not sent — it looks like it contains an API key"
            : "This looks like an API key"
        }
        onDismiss={sendBlocked ? undefined : onDismiss}
        actions={
          sendBlocked ? (
            <>
              {storeSecurelyButton}
              <Button variant="outlined" size="compact" onClick={onSendAnyway}>
                Send anyway
              </Button>
              <Button variant="ghost" size="compact" onClick={onDismiss}>
                Dismiss
              </Button>
            </>
          ) : (
            storeSecurelyButton
          )
        }
      >
        <span className="font-mono">{maskSecretValue(first.value)}</span>
        <p>
          Credentials sent in chat are visible in the transcript — store it
          securely instead.
        </p>
      </Notice>
    </div>
  );
}
