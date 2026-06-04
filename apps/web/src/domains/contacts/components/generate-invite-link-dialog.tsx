import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Loader2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";
import { Typography } from "@vellumai/design-library/components/typography";

import { buildA2AInviteLink } from "@/domains/contacts/a2a-invite";
import { integrationsA2aInvitePostMutation } from "@/generated/daemon/@tanstack/react-query.gen";

export interface GenerateInviteLinkDialogProps {
  open: boolean;
  assistantId: string;
  onClose: () => void;
}

function formatExpiry(expiresAt: number): string {
  const now = Date.now();
  const diffMs = expiresAt - now;
  if (diffMs <= 0) return "Expired";
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 1) return "Expires in 1 day";
  return `Expires in ${diffDays} days`;
}

export function GenerateInviteLinkDialog({
  open,
  assistantId,
  onClose,
}: GenerateInviteLinkDialogProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevOpenRef = useRef(false);

  const mutation = useMutation({
    ...integrationsA2aInvitePostMutation({
      path: { assistant_id: assistantId },
    }),
  });

  const mutateRef = useRef(mutation.mutate);
  useLayoutEffect(() => { mutateRef.current = mutation.mutate; });
  const resetRef = useRef(mutation.reset);
  useLayoutEffect(() => { resetRef.current = mutation.reset; });

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      mutateRef.current({ path: { assistant_id: assistantId } });
    }
    prevOpenRef.current = open;
  }, [open, assistantId]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleClose = useCallback(() => {
    resetRef.current();
    setCopied(false);
    if (copiedTimerRef.current) {
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
    onClose();
  }, [onClose]);

  const handleCopy = useCallback((url: string) => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const inviteUrl =
    mutation.isSuccess && mutation.data.token
      ? buildA2AInviteLink({
          senderAssistantId: assistantId,
          token: mutation.data.token,
        })
      : "";

  return (
    <Modal.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleClose();
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>Share Connection Link</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {mutation.isPending ? (
            <div
              className="flex items-center gap-2 py-2 text-body-medium-lighter"
              style={{ color: "var(--content-tertiary)" }}
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating invite link…
            </div>
          ) : mutation.isError ? (
            <div className="space-y-3">
              <p
                role="alert"
                className="!m-0 text-body-medium-lighter"
                style={{ color: "var(--system-negative-strong)" }}
              >
                Failed to create invite link. Make sure A2A is enabled for your
                assistant.
              </p>
              <Button
                variant="outlined"
                onClick={() =>
                  mutation.mutate({ path: { assistant_id: assistantId } })
                }
              >
                Try Again
              </Button>
            </div>
          ) : mutation.isSuccess ? (
            <div className="flex flex-col gap-3">
              <Typography
                variant="body-medium-lighter"
                style={{ color: "var(--content-secondary)" }}
              >
                Share this link with another assistant owner to establish a
                connection.
              </Typography>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  readOnly
                  value={inviteUrl}
                  fullWidth
                  wrapperClassName="flex-1"
                  className="font-mono"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  onClick={() => handleCopy(inviteUrl)}
                  aria-label="Copy invite link"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--border-base)] hover:bg-[var(--surface-hover)]"
                >
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
              {mutation.data.expiresAt != null && (
                <Typography
                  variant="body-small-default"
                  style={{ color: "var(--content-tertiary)" }}
                >
                  {formatExpiry(mutation.data.expiresAt)}
                </Typography>
              )}
            </div>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={handleClose}>
            Done
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
