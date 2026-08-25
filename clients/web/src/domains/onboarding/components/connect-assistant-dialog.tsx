import { Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";

import {
  cancelAssistantPairing,
  pollAssistantPairing,
  startAssistantPairing,
} from "@/lib/local-mode";
import { formatCountdown } from "@/utils/format-countdown";
import { useTranslation } from "@/i18n";

interface ConnectAssistantDialogProps {
  open: boolean;
  /** Prefills the address field when the dialog opens (deep-link entry). */
  initialAddress?: string;
  /** Extra guidance rendered above the form (deep-link entry with no address). */
  guidanceMessage?: string;
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One-field dialog for connecting an assistant running on another machine.
 * The field takes either artifact the host hands out: a pairing link, which
 * carries an already-approved device code and imports outright, or the bare
 * assistant address, which mints a challenge whose approval code the user
 * approves on the host while this dialog polls.
 *
 * The exchange itself runs in the local-mode host, so the device code and the
 * credentials it buys never reach the renderer; this component holds only the
 * opaque session handle. Host failures (an unusable address, an expired code,
 * a name collision) render inline, and an access-only pairing interposes an
 * expiry warning before completing.
 */
function ConnectAssistantDialog({
  open,
  initialAddress,
  guidanceMessage,
  onClose,
  onImported,
}: ConnectAssistantDialogProps) {
  const { t } = useTranslation("onboarding");
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the host answers with an approval code: the dialog swaps the form
  // for the code and polls until it is approved.
  const [session, setSession] = useState<ApprovalSession | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  // Set when an access-only pairing was imported: the dialog holds on the
  // expiry warning until the user continues into the connect flow.
  const [accessOnlyAssistantId, setAccessOnlyAssistantId] = useState<
    string | null
  >(null);
  // The live session, mirrored outside React state so the polling loop and the
  // teardown can reach it without re-running on every render.
  const handleRef = useRef<string | null>(null);
  const abandonedRef = useRef(false);

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
    setAccessOnlyAssistantId(null);
    abandonedRef.current = false;
    // Closing the dialog abandons whatever attempt is in flight: the loop
    // stops at its next checkpoint and the host forgets the session, so the
    // code cannot be exchanged behind a dismissed dialog.
    return () => {
      abandonedRef.current = true;
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
    try {
      const started = await startAssistantPairing(trimmedAddress);
      if (abandonedRef.current) {
        return;
      }
      if (!started.ok) {
        setError(started.error);
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

      for (;;) {
        const polled = await pollAssistantPairing(started.handle, trimmedName);
        if (abandonedRef.current) {
          return;
        }
        if (!polled.ok) {
          // A transport failure leaves the code exchangeable host-side, so the
          // abandoned session is dropped rather than left to time out.
          releaseSession();
          setSession(null);
          setError(polled.error);
          break;
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
        await sleep(polled.intervalSeconds * 1000);
        if (abandonedRef.current) {
          return;
        }
      }
    } catch (err) {
      console.error("connectAssistantDialog.pairing failed", err);
      releaseSession();
      setSession(null);
      setError(t("connectAssistantDialog.submitError"));
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
            {guidanceMessage && <Notice tone="info">{guidanceMessage}</Notice>}

            {session ? (
              <div className="flex flex-col gap-3">
                <code className="w-fit rounded-md bg-[var(--surface-active)] px-3 py-2 text-title-medium tracking-wide text-[color:var(--content-emphasised)]">
                  {session.userCode}
                </code>
                <p className="text-body-small-default text-[var(--content-secondary)]">
                  {t("connectAssistantDialog.approveOnHost")}
                </p>
                <div className="flex flex-wrap gap-x-2 text-body-small-default text-[var(--content-tertiary)]">
                  <span>{t("connectAssistantDialog.waitingForApproval")}</span>
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
                {error}
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
