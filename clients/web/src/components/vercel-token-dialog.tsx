import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

import { integrationsVercelConfigPost } from "@/generated/daemon/sdk.gen";
import { useTranslation } from "@/i18n";
import {
  Button,
  Input,
  Modal,
  toast,
  Typography,
} from "@vellumai/design-library";

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
  const { t } = useTranslation();
  const [token, setToken] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    if (!token.trim()) {
      return;
    }

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
        err instanceof Error
          ? err.message
          : t("vercelTokenDialog.saveFailed");
      setError(message);
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  }, [assistantId, token, onTokenSaved, t]);

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>{t("vercelTokenDialog.title")}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="flex flex-col gap-4">
            <Typography
              as="p"
              variant="body-medium-lighter"
              className="text-(--content-secondary)"
            >
              {t("vercelTokenDialog.body")}
            </Typography>
            <a
              href="https://vercel.com/account/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-body-medium-default text-(--primary-base) hover:underline"
            >
              {t("vercelTokenDialog.createToken")}
            </a>
            <Input
              type="password"
              placeholder={t("vercelTokenDialog.tokenPlaceholder")}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              label={t("vercelTokenDialog.tokenLabel")}
              fullWidth
              errorText={error}
              disabled={isSaving}
            />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="outlined" disabled={isSaving}>
              {t("vercelTokenDialog.cancel")}
            </Button>
          </Modal.Close>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={isSaving || !token.trim()}
            leftIcon={
              isSaving ? <Loader2 className="animate-spin" /> : undefined
            }
          >
            {isSaving
              ? t("vercelTokenDialog.saving")
              : t("vercelTokenDialog.save")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
