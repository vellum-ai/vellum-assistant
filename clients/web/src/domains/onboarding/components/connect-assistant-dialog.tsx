import { Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import type { PublicBaseUrlRejection } from "@vellumai/service-contracts/remote-web-pairing";

import {
  cancelAssistantPairing,
  isRetryablePairingFailure,
  pollAssistantPairing,
  startAssistantPairing,
} from "@/lib/local-mode";
import type { ConnectGuidanceKind } from "@/stores/connect-dialog-store";
import { formatCountdown } from "@/utils/format-countdown";
import { publicBaseUrlRejectionMessage } from "@/utils/pairing-address";
import { useTranslation } from "@/i18n";

interface ConnectAssistantDialogProps {
  open: boolean;
  /** Prefills the address field when the dialog opens (deep-link entry). */
  initialAddress?: string;
  /** Which guidance to render above the form (deep-link entry with no address). */
  guidanceKind?: ConnectGuidanceKind;
  onClose: () => void;
  /**
   * Fired once the pairing is imported and the lockfile refreshed, so the
   * caller can select and connect the new assistant. When the pairing is
   * access-only this fires only after the user acknowledges the expiry
   * warning.
   */
  onImported: (assistantId: string) => void;
}

/** A live approval-code session, held only while one is on screen. */
interface ApprovalSession {
  userCode: string;
  expiresAt: string;
}

/**
 * What to show inline when an attempt fails. A refused address carries the
 * structured reason, which this dialog renders from its own catalog; anything
 * else carries copy that is already display-ready.
 */
type ConnectFailure =
  | {
      kind: "rejected-address";
      rejection: PublicBaseUrlRejection;
      address: string;
    }
  | { kind: "message"; text: string };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Caps a retry backoff so a long attempt still polls on a useful cadence. */
const MAX_RETRY_BACKOFF_SECONDS = 30;

/** True once the attempt's deadline has passed; an unparseable one never is. */
const isPastDeadline = (expiresAt: string): boolean => {
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs;
};

/**
 * One-field dialog for connecting an assistant running on another machine.
 * The field takes either artifact the host hands out: a pairing link, which
 * carries an already-approved device code and imports outright, or the bare
 * assistant address, which mints a challenge whose approval code the user
 * approves on the host while this dialog polls.
 *
 * The exchange itself runs in the local-mode host, so the device code and the
 * credentials it buys never reach the renderer; this component holds only the
 * opaque session handle. Settled host failures (an unusable address, an
 * expired code, a name collision) render inline and end the attempt, a host
 * that is unreachable or not yet able to complete the exchange is polled
 * through until the code expires, and an access-only pairing interposes an
 * expiry warning before completing.
 */
function ConnectAssistantDialog({
  open,
  initialAddress,
  guidanceKind,
  onClose,
  onImported,
}: ConnectAssistantDialogProps) {
  const { t } = useTranslation("onboarding");
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ConnectFailure | null>(null);
  // Set once the host answers with an approval code: the dialog swaps the form
  // for the code and polls until it is approved.
  const [session, setSession] = useState<ApprovalSession | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  // Set while the host is unreachable and the attempt is polling through it,
  // so the countdown is not left ticking with no explanation.
  const [retrying, setRetrying] = useState(false);
  // Set when an access-only pairing was imported: the dialog holds on the
  // expiry warning until the user continues into the connect flow.
  const [accessOnlyAssistantId, setAccessOnlyAssistantId] = useState<
    string | null
  >(null);
  // The live session, mirrored outside React state so the polling loop and the
  // teardown can reach it without re-running on every render.
  const handleRef = useRef<string | null>(null);
  // One object per open, so an attempt is abandoned for good: a loop started
  // before a close cannot un-abandon itself when the dialog opens again.
  const attemptRef = useRef({ abandoned: false });

  // Drop a session the host may still hold. An attempt that ended in a reply
  // (imported, expired, denied) is already spent there, so callers past those
  // clear the ref directly instead.
  const releaseSession = (): void => {
    const handle = handleRef.current;
    handleRef.current = null;
    if (handle) {
      void cancelAssistantPairing(handle);
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    setAddress(initialAddress ?? "");
    setName("");
    setPending(false);
    setError(null);
    setSession(null);
    setRetrying(false);
    setAccessOnlyAssistantId(null);
    const attempt = { abandoned: false };
    attemptRef.current = attempt;
    // Closing the dialog abandons whatever attempt is in flight: the loop
    // stops at its next checkpoint and the host forgets the session, so the
    // code cannot be exchanged behind a dismissed dialog. A session the host
    // hands back after this point is dropped by the submit path, which has
    // the handle this teardown was still waiting on.
    return () => {
      attempt.abandoned = true;
      releaseSession();
    };
  }, [open, initialAddress]);

  useEffect(() => {
    if (!session) {
      return;
    }
    const timer = setInterval(
      () => setRemainingMs(Date.parse(session.expiresAt) - Date.now()),
      1000,
    );
    return () => clearInterval(timer);
  }, [session]);

  const handleSubmit = async () => {
    const trimmedAddress = address.trim();
    // pending also guards re-entry: a second click can land before React
    // flushes the pending state into the disabled buttons.
    if (!trimmedAddress || pending) {
      return;
    }
    setPending(true);
    setError(null);
    const trimmedName = name.trim() || undefined;
    const attempt = attemptRef.current;
    try {
      const started = await startAssistantPairing(trimmedAddress);
      if (attempt.abandoned) {
        // The dialog closed before the host answered, so the teardown had no
        // handle to drop. Drop the one it was waiting on, or the session and
        // the approval request it raised both live out their TTL.
        if (started.ok) {
          void cancelAssistantPairing(started.handle);
        }
        return;
      }
      if (!started.ok) {
        // A refused address is the one failure this dialog has copy for; the
        // host's `error` is English, so it stands in only when the refusal
        // names no reason.
        setError(
          started.rejection
            ? {
                kind: "rejected-address",
                rejection: started.rejection,
                address: trimmedAddress,
              }
            : { kind: "message", text: started.error },
        );
        setPending(false);
        return;
      }
      handleRef.current = started.handle;
      if (started.userCode) {
        setSession({
          userCode: started.userCode,
          expiresAt: started.expiresAt,
        });
        setRemainingMs(Date.parse(started.expiresAt) - Date.now());
      }

      // The approval wait promises to run until the code is approved or
      // expires, so a host that cannot be reached or answers a refusal that
      // leaves the code exchangeable backs off and polls again rather than
      // abandoning a session the host is deliberately keeping alive. Minting
      // the challenge already proved this address reachable, so a later
      // failure against it is transient.
      //
      // A pairing link is the other case: it opens a session without any
      // request, so nothing has proved the host is up, and there is no
      // approval to wait for. A failure is reported at once there instead of
      // hanging for the link's full TTL.
      const retryTransientFailures = started.userCode !== null;
      let expiresAt = started.expiresAt;
      let intervalSeconds = started.intervalSeconds;
      let consecutiveFailures = 0;

      for (;;) {
        const polled = await pollAssistantPairing(started.handle, trimmedName);
        if (attempt.abandoned) {
          // The teardown holds the handle from here on, so it does the
          // dropping; a second cancel would only race it.
          return;
        }
        if (!polled.ok) {
          const retryable =
            retryTransientFailures && isRetryablePairingFailure(polled);
          if (retryable && !isPastDeadline(expiresAt)) {
            consecutiveFailures += 1;
            if (consecutiveFailures === 1) {
              setRetrying(true);
            }
            await sleep(
              Math.min(
                intervalSeconds * consecutiveFailures,
                MAX_RETRY_BACKOFF_SECONDS,
              ) * 1000,
            );
            if (attempt.abandoned) {
              return;
            }
            continue;
          }
          // Settled, or the code ran out with the host still unreachable. A
          // transport failure leaves the code exchangeable host-side, so the
          // abandoned session is dropped rather than left to time out.
          releaseSession();
          setSession(null);
          setRetrying(false);
          setError({
            kind: "message",
            text: retryable
              ? t("connectAssistantDialog.retryExpired")
              : polled.error,
          });
          break;
        }
        if (consecutiveFailures > 0) {
          consecutiveFailures = 0;
          setRetrying(false);
        }
        if (polled.status === "imported") {
          handleRef.current = null;
          if (polled.accessOnly) {
            setSession(null);
            setAccessOnlyAssistantId(polled.assistantId);
            break;
          }
          onImported(polled.assistantId);
          return;
        }
        // Pending: the gateway names the deadline and the cadence, and the
        // host reports the attempt expired once that deadline passes. The
        // countdown follows the deadline the poll reports, so it cannot read
        // 0:00 while the loop is still legitimately polling.
        if (polled.expiresAt !== expiresAt) {
          setSession((prev) =>
            prev ? { ...prev, expiresAt: polled.expiresAt } : prev,
          );
          setRemainingMs(Date.parse(polled.expiresAt) - Date.now());
        }
        expiresAt = polled.expiresAt;
        intervalSeconds = polled.intervalSeconds;
        await sleep(intervalSeconds * 1000);
        if (attempt.abandoned) {
          return;
        }
      }
    } catch (err) {
      console.error("connectAssistantDialog.pairing failed", err);
      releaseSession();
      setSession(null);
      setRetrying(false);
      setError({
        kind: "message",
        text: t("connectAssistantDialog.submitError"),
      });
    }
    setPending(false);
  };

  if (accessOnlyAssistantId != null) {
    return (
      <Modal.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
      >
        <Modal.Content size="sm">
          <Modal.Header icon={Link2}>
            <Modal.Title>
              {t("connectAssistantDialog.importedTitle")}
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Notice tone="warning">
              {t("connectAssistantDialog.importedBody")}
            </Notice>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="primary"
              onClick={() => onImported(accessOnlyAssistantId)}
            >
              {t("actions.continue")}
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    );
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <Modal.Content size="md">
        <Modal.Header icon={Link2}>
          <Modal.Title>{t("connectAssistantDialog.title")}</Modal.Title>
          <Modal.Description>
            {t("connectAssistantDialog.instruction")}
          </Modal.Description>
        </Modal.Header>

        <Modal.Body>
          <div className="space-y-4">
            {guidanceKind && (
              <Notice tone="info">
                {t(
                  guidanceKind === "legacy"
                    ? "connectAssistantDialog.legacyLinkGuidance"
                    : "connectAssistantDialog.linkGuidance",
                )}
              </Notice>
            )}

            {session ? (
              <div className="flex flex-col gap-3">
                <code className="w-fit rounded-md bg-[var(--surface-active)] px-3 py-2 text-title-medium tracking-wide text-[color:var(--content-emphasised)]">
                  {session.userCode}
                </code>
                <p className="text-body-small-default text-[var(--content-secondary)]">
                  {t("connectAssistantDialog.approveOnHost")}
                </p>
                <div className="flex flex-wrap gap-x-2 text-body-small-default text-[var(--content-tertiary)]">
                  <span
                    className={
                      retrying
                        ? "text-[color:var(--system-warning-strong)]"
                        : undefined
                    }
                  >
                    {retrying
                      ? t("connectAssistantDialog.retrying")
                      : t("connectAssistantDialog.waitingForApproval")}
                  </span>
                  <span>
                    {t("connectAssistantDialog.expiresIn", {
                      time: formatCountdown(remainingMs),
                    })}
                  </span>
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <label
                    className="text-body-small-default text-[var(--content-secondary)]"
                    htmlFor="connect-assistant-address"
                  >
                    {t("connectAssistantDialog.addressLabel")}
                  </label>
                  <Input
                    id="connect-assistant-address"
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder={t("connectAssistantDialog.addressPlaceholder")}
                    fullWidth
                    autoFocus
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    className="text-body-small-default text-[var(--content-secondary)]"
                    htmlFor="connect-assistant-name"
                  >
                    {t("connectAssistantDialog.nameLabel")}
                  </label>
                  <Input
                    id="connect-assistant-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="office-mac"
                    fullWidth
                  />
                </div>
              </>
            )}

            {error && (
              <p className="text-body-small-default text-[var(--system-negative-strong)]">
                {error.kind === "rejected-address"
                  ? publicBaseUrlRejectionMessage(
                      error.rejection,
                      error.address,
                    )
                  : error.text}
              </p>
            )}
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="ghost" onClick={onClose}>
            {t("actions.cancel")}
          </Button>
          {!session && (
            <Button
              variant="primary"
              onClick={() => void handleSubmit()}
              disabled={!address.trim() || pending}
            >
              {pending ? t("actions.connecting") : t("actions.connect")}
            </Button>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

export { ConnectAssistantDialog };
