import { Globe } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";

import {
  normalizeOriginUrl,
  useRememberedOriginsStore,
  type RememberedOrigin,
} from "@/stores/remembered-origins-store";

const ADD_FAILED_COPY = "Failed to add the assistant. Please try again.";

/**
 * Drop the app-route tail from an address a user is likely to have copied
 * out of their browser, so both `<base>/assistant/pair` (what the pairing
 * page shows) and `<base>/assistant` reduce to the public base the store
 * remembers. A Velay path prefix survives because it is a different
 * segment: `https://host/assistant-123/assistant/pair` yields
 * `https://host/assistant-123`.
 */
function stripAppRouteSuffix(base: string): string {
  for (const route of ["/assistant/pair", "/assistant"]) {
    if (base.endsWith(route)) {
      return base.slice(0, -route.length);
    }
  }
  return base;
}

interface AddRemoteOriginDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Fired once the origin is remembered on this device, so the caller can
   * navigate to it.
   */
  onAdded: (origin: RememberedOrigin) => void;
}

/**
 * URL-only dialog for remembering a remote assistant origin in the hub
 * chooser. The address is validated as an https base on submit; invalid
 * input renders inline. No name field: the label arrives via pairing
 * artifacts (a `?register` handoff), so the hostname stands in as the
 * entry's title until then.
 */
function AddRemoteOriginDialog({
  open,
  onClose,
  onAdded,
}: AddRemoteOriginDialogProps) {
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUrl("");
      setPending(false);
      setError(null);
    }
  }, [open]);

  const handleClose = () => {
    if (!pending) {
      onClose();
    }
  };

  const handleSubmit = async () => {
    // pending also guards re-entry: a second click can land before React
    // flushes the pending state into the disabled buttons.
    if (!url.trim() || pending) {
      return;
    }
    const parsed = normalizeOriginUrl(url);
    // Re-normalize: stripping the route tail can leave a bare origin.
    const normalized =
      parsed === null ? null : normalizeOriginUrl(stripAppRouteSuffix(parsed));
    if (normalized === null) {
      setError(
        "Enter the full https address, like https://example.com/assistant-1.",
      );
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await useRememberedOriginsStore
        .getState()
        .addOrigin({ url: normalized });
      if (result.ok) {
        onAdded(result.origin);
        return;
      }
      setError(ADD_FAILED_COPY);
    } catch (err) {
      console.error("addRemoteOriginDialog.add failed", err);
      setError(ADD_FAILED_COPY);
    }
    setPending(false);
  };

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
        <Modal.Header icon={Globe}>
          <Modal.Title>Add a Remote Assistant</Modal.Title>
          <Modal.Description>
            Paste the https link your assistant&rsquo;s pairing page gave you.
          </Modal.Description>
        </Modal.Header>

        <Modal.Body>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label
                className="text-body-small-default text-[var(--content-secondary)]"
                htmlFor="add-remote-origin-url"
              >
                Assistant address
              </label>
              <Input
                id="add-remote-origin-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/assistant-1"
                fullWidth
                autoFocus
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
            disabled={!url.trim() || pending}
          >
            {pending ? "Adding…" : "Add"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

export { AddRemoteOriginDialog };
