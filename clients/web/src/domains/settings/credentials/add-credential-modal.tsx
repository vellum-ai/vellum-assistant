import { KeyRound, Loader2 } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useCredentialsSetPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";

/** Identity of a credential that was just saved to the vault. */
export interface SavedCredentialMeta {
  service: string;
  field: string;
  label?: string;
}

/** Optional values the form is seeded with each time the modal opens. */
export interface AddCredentialInitialValues {
  service?: string;
  field?: string;
  label?: string;
  value?: string;
}

export interface AddCredentialModalProps {
  open: boolean;
  /** Called when the modal closes — dismissal, Cancel, or a completed save. */
  onClose: () => void;
  /** Called after the credential is persisted to the vault. */
  onSaved: (meta: SavedCredentialMeta) => void;
  initialValues?: AddCredentialInitialValues;
}

/**
 * Modal form that stores a credential (service / field / secret value /
 * optional label) in the assistant's credential vault via the credentials-set
 * endpoint. Owns validation, the save mutation, and success/error toasts so
 * every call site shares identical behavior; callers handle what happens
 * after a save (e.g. invalidating their credentials list) in `onSaved`.
 */
export function AddCredentialModal({
  open,
  onClose,
  onSaved,
  initialValues,
}: AddCredentialModalProps) {
  const assistantId = useActiveAssistantId();

  const [service, setService] = useState(initialValues?.service ?? "");
  const [field, setField] = useState(initialValues?.field ?? "");
  const [value, setValue] = useState(initialValues?.value ?? "");
  const [label, setLabel] = useState(initialValues?.label ?? "");

  // Re-seed the form each time the modal opens so a prior open's draft never
  // leaks into a new one and fresh initialValues take effect. The ref keeps
  // the effect keyed on `open` alone — callers may pass a new initialValues
  // object every render, and re-running on that would clobber user typing.
  const initialValuesRef = useRef(initialValues);
  useLayoutEffect(() => {
    initialValuesRef.current = initialValues;
  }, [initialValues]);
  useEffect(() => {
    if (open) {
      const seed = initialValuesRef.current;
      setService(seed?.service ?? "");
      setField(seed?.field ?? "");
      setValue(seed?.value ?? "");
      setLabel(seed?.label ?? "");
    }
  }, [open]);

  const setMutation = useCredentialsSetPostMutation({
    onError: (err) => {
      toast.error(err.message || "Failed to save credential");
    },
  });
  const saving = setMutation.isPending;

  // Clear the fields on close so the secret doesn't linger in state while
  // the modal sits closed-but-mounted in the tree.
  const resetAndClose = () => {
    setService("");
    setField("");
    setValue("");
    setLabel("");
    onClose();
  };

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    const trimmedService = service.trim();
    const trimmedField = field.trim();
    // The secret value is stored verbatim — some secrets legitimately carry
    // leading/trailing whitespace, and the CLI set path stores them unchanged.
    // Trimming is used only to reject effectively-empty input.
    if (!trimmedService || !trimmedField || !value.trim()) {
      return;
    }
    const trimmedLabel = label.trim() || undefined;
    setMutation.mutate(
      {
        path: { assistant_id: assistantId },
        body: {
          service: trimmedService,
          field: trimmedField,
          value,
          label: trimmedLabel,
        },
      },
      {
        onSuccess: () => {
          toast.success("Credential saved.");
          onSaved({
            service: trimmedService,
            field: trimmedField,
            label: trimmedLabel,
          });
          resetAndClose();
        },
      },
    );
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(nextOpen) => {
        // Ignore dismissal (Escape / backdrop) while a save is in flight so a
        // slow or failing mutation can't discard the entered secret, which
        // the user may not be able to recover. The form clears only once the
        // mutation settles (resetAndClose runs on success and on explicit
        // Cancel, which is itself disabled while saving).
        if (!nextOpen && !saving) {
          resetAndClose();
        }
      }}
    >
      <Modal.Content size="sm">
        <form onSubmit={handleSave}>
          <Modal.Header>
            <Modal.Title icon={KeyRound}>Add credential</Modal.Title>
            <Modal.Description>
              Add an API key or token to let tools and integrations use it.
            </Modal.Description>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input
                label="Service"
                type="text"
                value={service}
                onChange={(e) => setService(e.target.value)}
                placeholder="e.g. github"
                autoFocus
                fullWidth
              />
              <Input
                label="Field"
                type="text"
                value={field}
                onChange={(e) => setField(e.target.value)}
                placeholder="e.g. api_token"
                fullWidth
              />
            </div>
            <Input
              label="Value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter the secret value"
              fullWidth
            />
            <Input
              label="Label (optional)"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. GitHub personal access token"
              fullWidth
            />
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="button"
              variant="outlined"
              onClick={resetAndClose}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                saving || !service.trim() || !field.trim() || !value.trim()
              }
              leftIcon={
                saving ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : undefined
              }
            >
              Save
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
