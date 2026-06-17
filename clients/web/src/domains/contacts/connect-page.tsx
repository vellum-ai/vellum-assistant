import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Link2, Loader2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { parseA2AInviteParams } from "@/domains/contacts/a2a-invite";
import { redeemA2AInvite } from "@/domains/contacts/contacts-gateway";
import { routes } from "@/utils/routes";

function isContactsGetKey(queryKey: readonly unknown[]): boolean {
  const first = queryKey[0];
  return (
    first !== null &&
    typeof first === "object" &&
    (first as { _id?: unknown })._id === "contactsGet"
  );
}

function mapErrorCode(errorCode: string | undefined, errorMessage: string | undefined): string {
  switch (errorCode) {
    case "expired":
    case "not_found":
      return "This invite link has expired or already been used.";
    case "already_redeemed_by_other":
      return "This invite has already been claimed by someone else.";
    case "sender_not_found":
      return "The sender's assistant could not be found.";
    case "not_platform_managed":
      return "A2A invite links are only supported for platform-hosted assistants.";
    default:
      return errorMessage || "Something went wrong. Please try again.";
  }
}

/**
 * Page rendered at `/assistant/connect` — handles incoming A2A invite links.
 *
 * Shows a confirmation view before redeeming the invite through the
 * Django broker. Requires `senderAssistantId` and `token` query params.
 */
export function ConnectPage() {
  const assistantId = useActiveAssistantId();
  return <ConnectPageInner assistantId={assistantId} />;
}

function ConnectPageInner({ assistantId }: { assistantId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const parsed = useMemo(
    () => parseA2AInviteParams(searchParams),
    [searchParams],
  );

  const mutation = useMutation({
    mutationFn: () => {
      if (!parsed) throw new Error("Invalid invite link");
      return redeemA2AInvite(assistantId, {
        senderAssistantId: parsed.senderAssistantId,
        token: parsed.token,
      });
    },
    onSuccess: (data) => {
      if (data.success) {
        void queryClient.invalidateQueries({
          predicate: (query) => isContactsGetKey(query.queryKey),
        });
        if (data.alreadyConnected) {
          toast("Already connected");
        } else {
          toast("Connected!");
        }
        void navigate(routes.contacts.root);
      }
    },
  });

  const handleCancel = useCallback(() => {
    void navigate(routes.contacts.root);
  }, [navigate]);

  const handleConnect = useCallback(() => {
    mutation.mutate();
  }, [mutation]);

  // Derive error message from mutation state
  const errorMessage = useMemo(() => {
    if (mutation.isError) {
      return mutation.error instanceof Error
        ? mutation.error.message
        : "Something went wrong. Please try again.";
    }
    if (mutation.data && !mutation.data.success) {
      return mapErrorCode(mutation.data.errorCode, mutation.data.error);
    }
    return null;
  }, [mutation.isError, mutation.error, mutation.data]);

  // Invalid link — no params
  if (!parsed) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <div className="flex flex-col gap-4 p-6">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-6 w-6" style={{ color: "var(--system-negative-strong)" }} />
              <Typography variant="title-small">
                Invalid invite link
              </Typography>
            </div>
            <Typography
              variant="body-medium-lighter"
              style={{ color: "var(--content-secondary)" }}
            >
              The link you followed is missing required parameters and cannot be used.
            </Typography>
            <div className="flex gap-2 pt-2">
              <Button variant="primary" onClick={handleCancel}>
                Go to Contacts
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <div className="flex flex-col gap-4 p-6">
          <div className="flex items-center gap-3">
            <Link2 className="h-6 w-6" style={{ color: "var(--content-secondary)" }} />
            <Typography variant="title-small">
              Connect assistants
            </Typography>
          </div>

          <Typography
            variant="body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            Accepting this link will create a trusted A2A connection between your assistant and the sender&apos;s.
          </Typography>

          {errorMessage && (
            <div
              className="flex items-center gap-2 rounded-md p-3"
              style={{
                backgroundColor: "var(--surface-negative-subtle)",
                color: "var(--system-negative-strong)",
              }}
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <Typography variant="body-small-default">
                {errorMessage}
              </Typography>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <Button
              variant="primary"
              onClick={handleConnect}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Connecting…
                </span>
              ) : (
                "Connect"
              )}
            </Button>
            <Button
              variant="outlined"
              onClick={handleCancel}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
