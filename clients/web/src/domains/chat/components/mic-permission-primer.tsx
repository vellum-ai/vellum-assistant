import { Mic } from "lucide-react";

import { isBatchSttSupported } from "@/domains/chat/components/voice-input-button";
import { getLocalBool, setLocalBool } from "@/utils/local-settings";
import { Button, Modal } from "@vellumai/design-library";
import { useTranslation } from "@/i18n";

const MIC_PRIMER_STORAGE_KEY = "vellum:voice:permissionPrimerSeen";

/**
 * Returns `true` when the microphone permission primer should be shown —
 * i.e. the browser supports SpeechRecognition and the user has not yet
 * dismissed the primer dialog.
 */
export function shouldShowMicPrimer(): boolean {
  if (!isBatchSttSupported()) {
    return false;
  }
  return !getLocalBool(MIC_PRIMER_STORAGE_KEY, false);
}

export interface MicPermissionPrimerProps {
  open: boolean;
  onContinue: () => void;
  onCancel: () => void;
}

/**
 * Web-only first-use primer dialog shown before triggering the browser's
 * microphone permission prompt. Explains why mic access is needed and lets
 * the user opt in before the system dialog appears.
 *
 * The caller (`handleVoiceBeforeStart`) skips this primer on Capacitor
 * iOS so `getUserMedia` proceeds directly to the OS
 * mic alert: this dialog renders Cancel, close-X, backdrop dismiss, and
 * Escape (Radix Dialog defaults), all of which Apple Guideline 5.1.1(iv)
 * prohibits before a permission request. iOS relies on
 * `NSMicrophoneUsageDescription` for the explanation instead.
 *
 * @see https://developer.apple.com/design/human-interface-guidelines/requesting-permission
 */
export function MicPermissionPrimer({
  open,
  onContinue,
  onCancel,
}: MicPermissionPrimerProps) {
  const { t } = useTranslation("chat");
  const handleContinue = () => {
    setLocalBool(MIC_PRIMER_STORAGE_KEY, true);
    onContinue();
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header icon={Mic}>
          <Modal.Title>{t("micPermissionPrimer.title")}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Modal.Description>
            {t("micPermissionPrimer.description")}
          </Modal.Description>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={onCancel}>
            {t("micPermissionPrimer.cancel")}
          </Button>
          <Button onClick={handleContinue}>
            {t("micPermissionPrimer.continue")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
