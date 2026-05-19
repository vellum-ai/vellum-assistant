
import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Input } from "@vellum/design-library/components/input";
import { Modal } from "@vellum/design-library/components/modal";
import { connectToAssistant } from "@/lib/contacts/api.js";

export interface ConnectAssistantDialogProps {
  open: boolean;
  assistantId: string;
  onSuccess: (contactId: string) => void;
  onClose: () => void;
}

export function ConnectAssistantDialog({
  open,
  assistantId,
  onSuccess,
  onClose,
}: ConnectAssistantDialogProps) {
  const [guardianHandle, setGuardianHandle] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      connectToAssistant(assistantId, {
        guardianHandle: guardianHandle.trim(),
        gatewayUrl: gatewayUrl.trim(),
      }),
    onSuccess: (data) => {
      onSuccess(data.contactId);
      setGuardianHandle("");
      setGatewayUrl("");
    },
  });

  const handleClose = useCallback(() => {
    setGuardianHandle("");
    setGatewayUrl("");
    mutation.reset();
    onClose();
  }, [mutation, onClose]);

  const canSubmit =
    guardianHandle.trim().length > 0 &&
    gatewayUrl.trim().length > 0 &&
    !mutation.isPending;

  return (
    <Modal.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleClose();
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>Connect to Assistant</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="flex flex-col gap-4">
            <Input
              label="Handle"
              required
              placeholder="e.g. alice-assistant"
              value={guardianHandle}
              onChange={(e) => setGuardianHandle(e.target.value)}
              fullWidth
            />
            <div className="flex flex-col gap-1.5">
              <Input
                label="Gateway URL"
                required
                placeholder="e.g. https://alice.vellum.app"
                value={gatewayUrl}
                onChange={(e) => setGatewayUrl(e.target.value)}
                fullWidth
              />
              <span
                className="text-body-small-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                The assistant&apos;s gateway URL. Required for all connections.
              </span>
            </div>
            {mutation.isError ? (
              <p
                role="alert"
                className="text-body-small-default"
                style={{ color: "var(--system-negative-strong)" }}
              >
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : "Failed to connect to assistant"}
              </p>
            ) : null}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={handleClose}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => mutation.mutate()}>
            Connect
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
