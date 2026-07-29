/**
 * Direction-dependent copy for the provisioning takeover and the surfaces that
 * bracket it: the background-exit confirm and its toasts, the completion card,
 * and the billing fetch-error card.
 *
 * A downgrade and a direction-unknown switch read identically. Neither can
 * claim an upgrade, and "plan change" is the one phrase that covers a step down
 * and a sideways move without guessing which one happened.
 */

/**
 * Which way the change the takeover is watching goes. "change" is the neutral
 * variant for a move with no knowable direction, e.g. a Custom sub switching to
 * a stock package.
 */
export type TakeoverDirection = "upgrade" | "downgrade" | "change";

export interface TakeoverCopy {
  /** WAITING / RESIZING heading, while the machine rolls out. */
  waitingStatus: string;
  /** STALLED heading once a reconcile failure has been captured. */
  snagStatus: string;
  /** STALLED caption when the captured failure carries no message of its own. */
  snagCaption: string;
  /** CONFIRMING heading, while the subscription read catches up. */
  confirmingStatus: string;
  /** CONFIRM_TIMEOUT heading, once that read has run out of patience. */
  confirmTimeoutStatus: string;
  /**
   * CONFIRM_TIMEOUT caption. Reassures that the change itself is safe, so it
   * may only name money where money was certainly taken: a net package
   * decrease lands as a credit toward the next invoice, with no payment at all.
   */
  confirmTimeoutCaption: string;
  /** Body of the confirm that gates the background exit. */
  backgroundConfirmMessage: string;
  /** Toast on a clean background exit. */
  backgroundExitToast: string;
  /** Toast on a background exit that is also retrying a failed reconcile. */
  backgroundRetryToast: string;
  /** Subtitle of the terminal completion card. */
  completeSubtitle: string;
  /** Body of the card shown when the billing reads themselves fail. */
  fetchErrorBody: string;
}

const UPGRADE: TakeoverCopy = {
  waitingStatus: "Upgrading your assistant…",
  snagStatus: "We hit a snag upgrading your assistant",
  snagCaption:
    "Retry in the background and we'll keep working on your upgrade.",
  confirmingStatus: "Confirming your upgrade…",
  confirmTimeoutStatus: "Still confirming your upgrade",
  confirmTimeoutCaption:
    "Your payment went through safely. This can take a minute.",
  backgroundConfirmMessage:
    "Your assistant is still upgrading. Chatting won't be available until it finishes. You can keep waiting here, or continue and we'll let you know when it's ready.",
  backgroundExitToast: "Your upgrade continues in the background.",
  backgroundRetryToast: "We'll retry your upgrade in the background.",
  completeSubtitle: "Enjoy the new found power.",
  fetchErrorBody:
    "We hit a problem checking your subscription. Your upgrade may still be processing. Return to billing to refresh.",
};

const PLAN_CHANGE: TakeoverCopy = {
  waitingStatus: "Updating your assistant…",
  snagStatus: "We hit a snag updating your assistant",
  snagCaption:
    "Retry in the background and we'll keep working on your plan change.",
  confirmingStatus: "Confirming your plan change…",
  confirmTimeoutStatus: "Still confirming your plan change",
  confirmTimeoutCaption:
    "Your plan change was submitted. This can take a minute.",
  backgroundConfirmMessage:
    "Your assistant is still updating. Chatting won't be available until it finishes. You can keep waiting here, or continue and we'll let you know when it's ready.",
  backgroundExitToast: "Your plan change continues in the background.",
  backgroundRetryToast: "We'll retry your plan change in the background.",
  completeSubtitle: "Your plan changes are live.",
  fetchErrorBody:
    "We hit a problem checking your subscription. Your plan change may still be processing. Return to billing to refresh.",
};

const COPY: Record<TakeoverDirection, TakeoverCopy> = {
  upgrade: UPGRADE,
  downgrade: PLAN_CHANGE,
  change: PLAN_CHANGE,
};

/**
 * Every string the takeover surfaces render for one direction. An absent
 * direction reads as an upgrade, which is what post-checkout onboarding always
 * is and the safest thing to say when a caller states nothing.
 */
export function takeoverCopy(
  direction: TakeoverDirection = "upgrade",
): TakeoverCopy {
  return COPY[direction];
}
