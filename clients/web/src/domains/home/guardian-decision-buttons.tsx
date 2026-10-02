import { useTranslation } from "@/i18n";
import type { FeedItemGuardianRequest } from "@vellumai/assistant-api";
import type { GuardianDecisionActionId } from "@vellumai/service-contracts/guardian-requests";
import { Button } from "@vellumai/design-library";

import { resolveGuardianDecisionOptions } from "./guardian-decision-options";

const LABEL_KEYS = {
  approve_once: "guardianDecisionButtons.approveOnce",
  reject: "guardianDecisionButtons.reject",
  trust: "guardianDecisionButtons.trust",
  verify_code: "guardianDecisionButtons.verifyCode",
  leave_unverified: "guardianDecisionButtons.leaveUnverified",
  block: "guardianDecisionButtons.block",
} as const satisfies Record<GuardianDecisionActionId, string>;

export interface GuardianDecisionButtonsProps {
  guardianRequest: Pick<FeedItemGuardianRequest, "decisionActions">;
  disabled: boolean;
  onDecide: (action: GuardianDecisionActionId) => void;
}

/**
 * The buttons a pending approval is decided with, one per decision its card
 * offers, labelled in the reader's language. A click does not bubble, so a
 * button inside a clickable row decides without also opening the row.
 *
 * Emphasis follows the in-app card: the primary decision is a filled button
 * and every other one is outlined. Trust reads "Trust anyway" beside a code
 * handshake, as it does on the card.
 */
export function GuardianDecisionButtons({
  guardianRequest,
  disabled,
  onDecide,
}: GuardianDecisionButtonsProps) {
  const { t } = useTranslation("home");
  const options = resolveGuardianDecisionOptions(guardianRequest);
  const offersHandshake = options.some((option) => option.id === "verify_code");

  return (
    <>
      {options.map((option) => (
        <Button
          key={option.id}
          variant={option.emphasis === "primary" ? "primary" : "outlined"}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onDecide(option.id);
          }}
        >
          {option.id === "trust" && offersHandshake
            ? t("guardianDecisionButtons.trustAnyway")
            : t(LABEL_KEYS[option.id])}
        </Button>
      ))}
    </>
  );
}
