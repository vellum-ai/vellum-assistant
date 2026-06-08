import { Loader2 } from "lucide-react";
import { useState } from "react";

import { createPlatformAssistant } from "@/assistant/create-platform-assistant";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";

interface CreateAssistantDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Name-prompt dialog for the tray "New Assistant…" command. Mirrors the native
 * client: prompt for an optional name, hatch an *additional* managed assistant
 * (`mode: "create"`), and switch to it. Hosted in RootLayout and opened by the
 * `createAssistant` command handler. (Electron disables `window.prompt`, so a
 * real dialog is required rather than a native prompt.)
 */
export function CreateAssistantDialog({
  open,
  onClose,
}: CreateAssistantDialogProps) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  const handleCreate = async () => {
    setPending(true);
    const result = await createPlatformAssistant(name.trim() || undefined);
    setPending(false);
    if (result.ok) {
      toast.success("New assistant created.");
      setName("");
      onClose();
      return;
    }
    toast.error(result.error);
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>New Assistant</Modal.Title>
          <Modal.Description>
            Provision a new assistant. It will start up in the background.
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Assistant name (optional)"
            autoFocus
            disabled={pending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !pending) void handleCreate();
            }}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleCreate()}
            disabled={pending}
            leftIcon={
              pending ? <Loader2 className="animate-spin" /> : undefined
            }
          >
            Create
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
