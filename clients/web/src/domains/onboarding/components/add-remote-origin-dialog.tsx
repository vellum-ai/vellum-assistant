import { Globe } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import {
  isTunnelProviderWebsiteUrl,
  normalizePairingBaseUrl,
  parseRemoteWebPairingParams,
  type PublicBaseUrlRejection,
} from "@vellumai/service-contracts/remote-web-pairing";

import {
  normalizeOriginUrl,
  useRememberedOriginsStore,
  type RememberedOrigin,
} from "@/stores/remembered-origins-store";
import { publicBaseUrlRejectionMessage } from "@/utils/pairing-address";
import { useTranslation } from "@/i18n";

type OriginToRemember =
  | { ok: true; url: string; deviceCode: string | null }
  | { ok: false; reason: PublicBaseUrlRejection };

/**
 * Reduce a pasted address to the origin this device remembers, or name why it
 * cannot be one.
 *
 * The gate is `normalizeOriginUrl`, the same boundary the `?register` handoff
 * applies and the one the iOS shell's `SelfHostedServer.validate` mirrors. The
 * stricter `resolvePublicBaseUrl` gate is SSRF containment for a host that
 * POSTs to the address; an entry here is a target this browser navigates to,
 * so a LAN assistant (`https://192.168.1.5:8443`, `https://[fd00::1]`) stays
 * addable. A tunnel vendor's own website is still refused: no assistant lives
 * behind one, so it is a paste mistake with a better answer than an entry
 * pointing at a marketing page.
 */
function resolveOriginToRemember(raw: string): OriginToRemember {
  let base: string;
  try {
    // The app-route tail is dropped, a path prefix survives
    // (`https://host/assistant-123/assistant/pair` yields
    // `https://host/assistant-123`).
    base = normalizePairingBaseUrl(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (isTunnelProviderWebsiteUrl(base)) {
    return { ok: false, reason: "service-website" };
  }
  const url = normalizeOriginUrl(base);
  if (url === null) {
    // Everything `normalizeOriginUrl` refuses past a parse is a scheme that is
    // not https, a `javascript:`/`mailto:` opaque url included.
    return { ok: false, reason: "non-https" };
  }
  return {
    ok: true,
    url,
    deviceCode: parseRemoteWebPairingParams(raw).deviceCode,
  };
}

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
 * pair page to mint a code there. The address is validated on submit; a
 * refusal renders inline, naming the reason. No name field: the label arrives
 * via pairing artifacts (a `?register` handoff), so the hostname stands in as
 * the entry's title until then.
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
    const parsed = resolveOriginToRemember(url);
    if (!parsed.ok) {
      setError(publicBaseUrlRejectionMessage(parsed.reason, url));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await useRememberedOriginsStore
        .getState()
        .addOrigin({ url: parsed.url });
      if (result.ok) {
        onAdded(result.origin, parsed.deviceCode);
        return;
      }
      setError(t("addRemoteOriginDialog.addFailed"));
    } catch (err) {
      console.error("addRemoteOriginDialog.add failed", err);
      setError(t("addRemoteOriginDialog.addFailed"));
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
