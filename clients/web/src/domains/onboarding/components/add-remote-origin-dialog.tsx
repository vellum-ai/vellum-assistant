import { Globe } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { parsePairingAddress } from "@vellumai/service-contracts/remote-web-pairing";

import {
  useRememberedOriginsStore,
  type RememberedOrigin,
} from "@/stores/remembered-origins-store";
import { useTranslation } from "@/i18n";

const ADD_FAILED_COPY = "Failed to add the assistant. Please try again.";

interface AddRemoteOriginDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Fired once the origin is remembered on this device, so the caller can
   * navigate to it. `deviceCode` is the approved code a pasted pairing link
   * carried, for the caller to spend on that navigation; it is never stored.
   */
  onAdded: (origin: RememberedOrigin, deviceCode: string | null) => void;
}

/**
 * URL-only dialog for remembering a remote assistant origin in the hub
 * chooser. The field takes the same artifact every other pairing surface
 * takes: a pairing link, whose approved device code rides out to the caller
 * for the navigation, or the bare https base, which lands on the origin's own
 * pair page to mint a code there. The address is validated on submit; invalid
 * input renders inline. No name field: the label arrives via pairing
 * artifacts (a `?register` handoff), so the hostname stands in as the
 * entry's title until then.
 *
 * Only the base is remembered. The device code is one-time credential
 * material: it stays in this call and never reaches the origin store.
 */
function AddRemoteOriginDialog({
  open,
  onClose,
  onAdded,
}: AddRemoteOriginDialogProps) {
  const { t } = useTranslation("onboarding");
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
    // Reduce an address copied out of a browser to the public base the store
    // remembers, keeping the device code a pairing link carries: the app-route
    // tail is dropped, a path prefix survives
    // (`https://host/assistant-123/assistant/pair` yields
    // `https://host/assistant-123`).
    const parsed = parsePairingAddress(url);
    if (!parsed.ok) {
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
        .addOrigin({ url: parsed.publicBaseUrl });
      if (result.ok) {
        onAdded(result.origin, parsed.deviceCode);
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
          <Modal.Title>{t("addRemoteOriginDialog.title")}</Modal.Title>
          <Modal.Description>
            {t("addRemoteOriginDialog.body")}
          </Modal.Description>
        </Modal.Header>

        <Modal.Body>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label
                className="text-body-small-default text-[var(--content-secondary)]"
                htmlFor="add-remote-origin-url"
              >
                {t("addRemoteOriginDialog.addressLabel")}
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
            {t("actions.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSubmit()}
            disabled={!url.trim() || pending}
          >
            {pending ? t("actions.adding") : t("actions.add")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

export { AddRemoteOriginDialog };
