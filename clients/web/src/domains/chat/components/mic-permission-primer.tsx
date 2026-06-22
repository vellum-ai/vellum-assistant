
import { Mic } from "lucide-react";

import { isBatchSttSupported } from "@/domains/chat/components/voice-input-button";
import { getLocalBool, setLocalBool } from "@/utils/local-settings";
import { Button, Modal } from "@vellumai/design-library";

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
        <Modal.Header>
          <Modal.Title icon={Mic}>Microphone Access</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Modal.Description>
            Voice input requires microphone access. Audio is transcribed by
            your configured speech-to-text provider, or by your
            device&apos;s built-in dictation when no provider is set.
          </Modal.Description>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleContinue}>Continue</Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
