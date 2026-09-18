import { AtSign } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, cn } from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";

import { useTranslation } from "@/i18n";

import type { HandleClaimIo } from "../types";
import { AddressPill } from "./address-pill";
import { HANDLE_FIELD_CLASSES, toHandleInput } from "./email-address-fields";

/** Long enough that a probe is not fired per keystroke. */
const HANDLE_CHECK_DELAY_MS = 400;

/**
 * The shape of a handle the platform made up at sign-up, two words and a
 * short code. Only picks the invitation's wording: a handle like that was
 * never chosen, so the control says "claim"; any other was, so it says
 * "change". Both do the same thing, so a wrong guess costs nothing.
 */
const GENERATED_HANDLE = /^[a-z]+-[a-z]+-[a-z0-9]{4,8}$/;

export interface HandleClaimProps {
  /** Whose address this is; the pill wears their avatar and accent. */
  assistantId: string;
  /** The current handle; empty when it is not known or never set. */
  handle: string;
  rootDomain: string;
  /** The handle calls. Without them this is the example address and no more. */
  claim?: HandleClaimIo | null;
  align?: "center" | "start";
}

/**
 * The example address with the way to make it one's own. At rest it is the
 * identity pill and, beside it, an invitation to claim a handle: an assistant
 * that never chose one carries a generated name, and an address built on it
 * is a poor advert for the feature. Opened, the handle becomes a field, the
 * pill previews what is typed, and saving claims it. Claiming needs no plan,
 * so the pitch gives the reader something to own before it asks for anything.
 * Nothing here is permanent: the handle only locks when a domain is
 * registered on it, which is the setup card's business.
 */
export function HandleClaim({
  assistantId,
  handle,
  rootDomain,
  claim,
  align = "center",
}: HandleClaimProps) {
  const { t } = useTranslation("assistant-inbox");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(handle);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setProblem(null);
    if (!editing || !claim || !draft || draft === handle) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      claim
        .check(draft, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted && !result.available) {
            setProblem(result.message);
          }
        })
        .catch(() => {
          // Advisory only: the save decides, so a failed probe is silent.
        });
    }, HANDLE_CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [claim, draft, editing, handle]);

  const shown = editing ? draft : handle;
  const prefix = t("emailAddressFields.prefixPlaceholder");
  const centred = align === "center";

  const save = async () => {
    if (!claim) {
      return;
    }
    setSaving(true);
    const result = await claim.save(draft);
    setSaving(false);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    setEditing(false);
    toast.success(t("handleClaim.claimedToast", { handle: draft }));
  };

  return (
    <div
      className={cn(
        "flex max-w-full flex-col gap-3",
        centred ? "items-center" : "items-start",
      )}
    >
      <div
        className={cn(
          "flex max-w-full flex-wrap items-center gap-x-2 gap-y-2",
          centred ? "justify-center" : "justify-start",
        )}
      >
        {shown ? (
          <AddressPill
            assistantId={assistantId}
            address={`${prefix}@${shown}.${rootDomain}`}
          />
        ) : null}
        {claim && !editing ? (
          <Button
            variant="ghost"
            size="compact"
            leftIcon={<AtSign />}
            onClick={() => {
              setDraft(handle);
              setEditing(true);
            }}
          >
            {!handle || GENERATED_HANDLE.test(handle)
              ? t("handleClaim.claimButton")
              : t("handleClaim.changeButton")}
          </Button>
        ) : null}
      </div>
      {claim && editing ? (
        <form
          className={cn(
            "flex max-w-full flex-col gap-1.5",
            centred ? "items-center" : "items-start",
          )}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <input
              aria-label={t("emailAddressFields.handleLabel")}
              aria-invalid={problem !== null}
              value={draft}
              onChange={(event) => setDraft(toHandleInput(event.target.value))}
              disabled={saving}
              autoFocus
              placeholder={t("emailAddressFields.handlePlaceholder")}
              className={`${HANDLE_FIELD_CLASSES} w-44 min-w-0`}
            />
            <span className="shrink-0 text-[14px] text-[var(--content-tertiary)]">
              .{rootDomain}
            </span>
            <Button
              type="submit"
              variant="primary"
              size="compact"
              disabled={
                !draft || draft === handle || saving || problem !== null
              }
            >
              {t("handleClaim.saveButton")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="compact"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              {t("handleClaim.cancelButton")}
            </Button>
          </div>
          {problem ? (
            <p
              role="alert"
              className="text-body-small-default text-[var(--system-negative-strong)]"
            >
              {problem}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
