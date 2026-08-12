import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Link2, Loader2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { toast } from "@vellumai/design-library/components/toast";
import { Typography } from "@vellumai/design-library/components/typography";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useTranslation } from "@/i18n";
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

/**
 * Catalog key for a redemption failure the broker reports by code. Null when
 * the code is unrecognized, which leaves the broker's own message (or the
 * generic fallback) to speak for it.
 */
function inviteErrorKey(errorCode: string | undefined) {
  switch (errorCode) {
    case "expired":
    case "not_found":
      return "connectPage.errorExpired";
    case "already_redeemed_by_other":
      return "connectPage.errorAlreadyRedeemed";
    case "sender_not_found":
      return "connectPage.errorSenderNotFound";
    case "not_platform_managed":
      return "connectPage.errorNotPlatformManaged";
    default:
      return null;
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
  const { t } = useTranslation("contacts");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const parsed = useMemo(
    () => parseA2AInviteParams(searchParams),
    [searchParams],
  );

  const mutation = useMutation({
    mutationFn: () => {
      if (!parsed) {
        throw new Error("Invalid invite link");
      }
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
          toast(t("connectPage.alreadyConnected"));
        } else {
          toast(t("connectPage.connected"));
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
        : t("connectPage.errorGeneric");
    }
    if (mutation.data && !mutation.data.success) {
      const key = inviteErrorKey(mutation.data.errorCode);
      if (key) {
        return t(key);
      }
      return mutation.data.error || t("connectPage.errorGeneric");
    }
    return null;
  }, [mutation.isError, mutation.error, mutation.data, t]);

  // Invalid link — no params
  if (!parsed) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <div className="flex flex-col gap-4 p-6">
            <div className="flex items-center gap-3">
              <AlertTriangle
                className="h-6 w-6"
                style={{ color: "var(--system-negative-strong)" }}
              />
              <Typography variant="title-small">
                {t("connectPage.invalidTitle")}
              </Typography>
            </div>
            <Typography
              variant="body-medium-lighter"
              style={{ color: "var(--content-secondary)" }}
            >
              {t("connectPage.invalidBody")}
            </Typography>
            <div className="flex gap-2 pt-2">
              <Button variant="primary" onClick={handleCancel}>
                {t("connectPage.goToContacts")}
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
            <Link2
              className="h-6 w-6"
              style={{ color: "var(--content-secondary)" }}
            />
            <Typography variant="title-small">
              {t("connectPage.title")}
            </Typography>
          </div>

          <Typography
            variant="body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            {t("connectPage.body")}
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
                  {t("actions.connecting")}
                </span>
              ) : (
                t("actions.connect")
              )}
            </Button>
            <Button
              variant="outlined"
              onClick={handleCancel}
              disabled={mutation.isPending}
            >
              {t("actions.cancel")}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
