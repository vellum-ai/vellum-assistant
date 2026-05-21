import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Loader2, UserPlus, XCircle } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Input } from "@vellum/design-library/components/input";
import { Typography } from "@vellum/design-library/components/typography";

import { parseA2AInviteParams } from "@/domains/contacts/a2a-invite.js";
import type { A2AInviteParams } from "@/domains/contacts/a2a-invite.js";
import { acceptA2AInvite } from "@/domains/contacts/api.js";
import { useActiveAssistantContext } from "@/domains/chat/active-assistant-gate.js";
import { routes } from "@/utils/routes.js";

/**
 * Page rendered at `/assistant/connect` — handles incoming A2A invite links.
 *
 * When opened via a link (with `senderAssistantId`, `token`, and
 * `senderGatewayUrl` query params), it auto-accepts the invite.
 * When opened directly (no params), it shows a form for manual entry.
 */
export function ConnectPage() {
  const { assistantId } = useActiveAssistantContext();
  return <ConnectPageInner assistantId={assistantId} />;
}

function ConnectPageInner({ assistantId }: { assistantId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const inviteParams = useMemo(
    () => parseA2AInviteParams(searchParams),
    [searchParams],
  );

  const [manualGatewayUrl, setManualGatewayUrl] = useState("");
  const [manualAssistantId, setManualAssistantId] = useState("");
  const [manualToken, setManualToken] = useState("");

  const mutation = useMutation({
    mutationFn: (params: A2AInviteParams) =>
      acceptA2AInvite(assistantId, params),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["assistantContacts", assistantId],
      });
    },
  });

  const mutateRef = useRef(mutation.mutate);
  mutateRef.current = mutation.mutate;

  // Auto-accept when opened via invite link
  const autoAcceptedRef = useRef(false);
  useEffect(() => {
    if (inviteParams && !autoAcceptedRef.current) {
      autoAcceptedRef.current = true;
      mutateRef.current(inviteParams);
    }
  }, [inviteParams]);

  const handleManualSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      mutation.mutate({
        senderGatewayUrl: manualGatewayUrl.trim(),
        senderAssistantId: manualAssistantId.trim(),
        token: manualToken.trim(),
      });
    },
    [mutation, manualGatewayUrl, manualAssistantId, manualToken],
  );

  const handleGoToContacts = useCallback(() => {
    void navigate(routes.contacts.root);
  }, [navigate]);

  const handleGoBack = useCallback(() => {
    void navigate(routes.assistant);
  }, [navigate]);

  const isManualValid =
    manualGatewayUrl.trim() !== "" &&
    manualAssistantId.trim() !== "" &&
    manualToken.trim() !== "";

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <div className="flex flex-col gap-4 p-6">
          <div className="flex items-center gap-3">
            <UserPlus className="h-6 w-6" style={{ color: "var(--content-secondary)" }} />
            <Typography variant="title-small">
              Accept Connection
            </Typography>
          </div>

          {mutation.isPending ? (
            <div
              className="flex items-center gap-2 py-4"
              style={{ color: "var(--content-tertiary)" }}
            >
              <Loader2 className="h-5 w-5 animate-spin" />
              <Typography variant="body-medium-lighter">
                Connecting to assistant…
              </Typography>
            </div>
          ) : mutation.isSuccess ? (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex items-center gap-2" style={{ color: "var(--system-positive-strong)" }}>
                <CheckCircle className="h-5 w-5" />
                <Typography variant="body-medium-default">
                  {mutation.data.alreadyConnected
                    ? "Already connected to this assistant."
                    : "Connected successfully!"}
                </Typography>
              </div>
              <div className="flex gap-2">
                <Button variant="primary" onClick={handleGoToContacts}>
                  View Contacts
                </Button>
                <Button variant="outlined" onClick={handleGoBack}>
                  Back to Chat
                </Button>
              </div>
            </div>
          ) : mutation.isError ? (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex items-center gap-2" style={{ color: "var(--system-negative-strong)" }}>
                <XCircle className="h-5 w-5" />
                <Typography variant="body-medium-default">
                  {mutation.error instanceof Error
                    ? mutation.error.message
                    : "Failed to accept invite."}
                </Typography>
              </div>
              <div className="flex gap-2">
                {inviteParams ? (
                  <Button
                    variant="outlined"
                    onClick={() => mutation.mutate(inviteParams)}
                  >
                    Try Again
                  </Button>
                ) : (
                  <Button
                    variant="outlined"
                    onClick={() => mutation.reset()}
                  >
                    Edit &amp; Retry
                  </Button>
                )}
                <Button variant="outlined" onClick={handleGoBack}>
                  Back to Chat
                </Button>
              </div>
            </div>
          ) : inviteParams ? (
            <div
              className="flex items-center gap-2 py-4"
              style={{ color: "var(--content-tertiary)" }}
            >
              <Loader2 className="h-5 w-5 animate-spin" />
              <Typography variant="body-medium-lighter">
                Connecting to assistant…
              </Typography>
            </div>
          ) : (
            <ManualEntryForm
              gatewayUrl={manualGatewayUrl}
              onGatewayUrlChange={setManualGatewayUrl}
              assistantIdValue={manualAssistantId}
              onAssistantIdChange={setManualAssistantId}
              token={manualToken}
              onTokenChange={setManualToken}
              isValid={isManualValid}
              onSubmit={handleManualSubmit}
              onCancel={handleGoBack}
            />
          )}
        </div>
      </Card>
    </div>
  );
}

function ManualEntryForm({
  gatewayUrl,
  onGatewayUrlChange,
  assistantIdValue,
  onAssistantIdChange,
  token,
  onTokenChange,
  isValid,
  onSubmit,
  onCancel,
}: {
  gatewayUrl: string;
  onGatewayUrlChange: (v: string) => void;
  assistantIdValue: string;
  onAssistantIdChange: (v: string) => void;
  token: string;
  onTokenChange: (v: string) => void;
  isValid: boolean;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <Typography
        variant="body-medium-lighter"
        style={{ color: "var(--content-secondary)" }}
      >
        Enter the invite details to connect to another assistant.
      </Typography>
      <label className="flex flex-col gap-1">
        <Typography variant="body-small-default">Gateway URL</Typography>
        <Input
          type="url"
          placeholder="https://assistant.example.com"
          value={gatewayUrl}
          onChange={(e) => onGatewayUrlChange(e.target.value)}
          fullWidth
        />
      </label>
      <label className="flex flex-col gap-1">
        <Typography variant="body-small-default">Assistant ID</Typography>
        <Input
          type="text"
          placeholder="Sender assistant ID"
          value={assistantIdValue}
          onChange={(e) => onAssistantIdChange(e.target.value)}
          fullWidth
        />
      </label>
      <label className="flex flex-col gap-1">
        <Typography variant="body-small-default">Invite Token</Typography>
        <Input
          type="text"
          placeholder="Invite token"
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          fullWidth
        />
      </label>
      <div className="flex gap-2 pt-2">
        <Button type="submit" variant="primary" disabled={!isValid}>
          Accept Invite
        </Button>
        <Button type="button" variant="outlined" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
