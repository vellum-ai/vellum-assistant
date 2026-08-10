import { Link2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input, Textarea } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";

import { importPairedAssistantBundle } from "@/lib/local-mode";

interface ConnectAssistantDialogProps {
  open: boolean;
  /** Prefills the bundle field when the dialog opens (deep-link entry). */
  initialBundle?: string;
  /** Extra guidance rendered above the form (deep-link entry with no bundle). */
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

/**
 * Paste-a-bundle dialog for connecting a remote assistant paired via
 * `vellum pair` on another machine. Submitting registers the pairing through
 * the local-mode host and refreshes the lockfile; host failures (malformed
 * bundle, name collision, unsupported app version) render inline. An
 * access-only pairing interposes an expiry warning before completing.
 */
function ConnectAssistantDialog({
  open,
  initialBundle,
  guidanceMessage,
  onClose,
  onImported,
}: ConnectAssistantDialogProps) {
  const [bundle, setBundle] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when an access-only pairing was imported: the dialog holds on the
  // expiry warning until the user continues into the connect flow.
  const [accessOnlyAssistantId, setAccessOnlyAssistantId] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (open) {
      setBundle(initialBundle ?? "");
      setName("");
      setPending(false);
      setError(null);
      setAccessOnlyAssistantId(null);
    }
  }, [open, initialBundle]);

  const handleClose = () => {
    if (!pending) {
      onClose();
    }
  };

  const handleSubmit = async () => {
    const trimmedBundle = bundle.trim();
    // pending also guards re-entry: a second click can land before React
    // flushes the pending state into the disabled buttons.
    if (!trimmedBundle || pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      const result = await importPairedAssistantBundle(
        trimmedBundle,
        trimmedName || undefined,
      );
      if (!result.ok) {
        setError(result.error);
      } else if (result.accessOnly) {
        setAccessOnlyAssistantId(result.assistantId);
      } else {
        onImported(result.assistantId);
        return;
      }
    } catch (err) {
      console.error("connectAssistantDialog.import failed", err);
      setError("Failed to import the pairing bundle. Please try again.");
    }
    setPending(false);
  };

  if (accessOnlyAssistantId != null) {
    return (
      <Modal.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            handleClose();
          }
        }}
      >
        <Modal.Content size="sm">
          <Modal.Header icon={Link2}>
            <Modal.Title>Pairing Imported</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Notice tone="warning">
              This pairing is access-only: its access expires and cannot renew
              itself. Re-run vellum pair on the assistant&rsquo;s machine and
              import the new bundle when it expires.
            </Notice>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="primary"
              onClick={() => onImported(accessOnlyAssistantId)}
            >
              Continue
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
          handleClose();
        }
      }}
    >
      <Modal.Content size="md">
        <Modal.Header icon={Link2}>
          <Modal.Title>Connect a Remote Assistant</Modal.Title>
          <Modal.Description>
            On the assistant&rsquo;s machine, run{" "}
            <code>vellum pair --url https://...</code> and paste the bundle
            here.
          </Modal.Description>
        </Modal.Header>

        <Modal.Body>
          <div className="space-y-4">
            {guidanceMessage && <Notice tone="info">{guidanceMessage}</Notice>}

            <div className="space-y-1.5">
              <label
                className="text-body-small-default text-[var(--content-secondary)]"
                htmlFor="connect-assistant-bundle"
              >
                Pairing bundle
              </label>
              <Textarea
                id="connect-assistant-bundle"
                value={bundle}
                onChange={(e) => setBundle(e.target.value)}
                placeholder="eyJnYXRld2F5..."
                rows={4}
                fullWidth
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label
                className="text-body-small-default text-[var(--content-secondary)]"
                htmlFor="connect-assistant-name"
              >
                Name (optional)
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

            {error && (
              <p className="text-body-small-default text-[var(--system-negative-strong)]">
                {error}
              </p>
            )}
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="ghost" onClick={handleClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSubmit()}
            disabled={!bundle.trim() || pending}
          >
            {pending ? "Connecting…" : "Connect"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

export { ConnectAssistantDialog };
