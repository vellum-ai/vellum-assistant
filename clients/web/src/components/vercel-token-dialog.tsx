import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

import { integrationsVercelConfigPost } from "@/generated/daemon/sdk.gen";
import { Button, Input, Modal, toast, Typography } from "@vellumai/design-library";

export interface VercelTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assistantId: string;
  onTokenSaved: () => void;
}

export function VercelTokenDialog({
  open,
  onOpenChange,
  assistantId,
  onTokenSaved,
}: VercelTokenDialogProps) {
  const [token, setToken] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    if (!token.trim()) return;

    setIsSaving(true);
    setError(null);

    try {
      await integrationsVercelConfigPost({
        path: { assistant_id: assistantId },
        body: { action: "set", apiToken: token.trim() },
        throwOnError: true,
      });
      setToken("");
      onTokenSaved();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save Vercel token.";
      setError(message);
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  }, [assistantId, token, onTokenSaved]);

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>Connect Vercel</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="flex flex-col gap-4">
            <Typography
              as="p"
              variant="body-medium-lighter"
              className="text-(--content-secondary)"
            >
              Enter your Vercel API token to deploy apps as static pages.
            </Typography>
            <a
              href="https://vercel.com/account/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-body-medium-default text-(--primary-base) hover:underline"
            >
              Create a token on Vercel &rarr;
            </a>
            <Input
              type="password"
              placeholder="Vercel API token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              label="API Token"
              fullWidth
              errorText={error}
              disabled={isSaving}
            />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="outlined" disabled={isSaving}>
              Cancel
            </Button>
          </Modal.Close>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={isSaving || !token.trim()}
            leftIcon={isSaving ? <Loader2 className="animate-spin" /> : undefined}
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
