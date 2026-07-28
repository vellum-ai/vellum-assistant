import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { useQueryClient } from "@tanstack/react-query";

import { assistantsDomainsListQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { CreditTierEnum } from "@/generated/api/types.gen";
import {
  clearCheckoutIntent,
  readPurchasedCheckoutIntent,
  type CheckoutIntent,
} from "@/lib/billing/checkout-intent";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Modal } from "@vellumai/design-library/components/modal";
import { toast } from "@vellumai/design-library/components/toast";

import { CompleteState } from "./complete-state";
import { DomainStep } from "./domain-step";
import { FetchErrorState } from "./error-states";
import type {
  ProvisioningDimensions,
  ProvisioningStateKind,
} from "./provisioning-machine";
import {
  ProvisioningState,
  TAKEOVER_SURFACE,
  TAKEOVER_SURFACE_VAR,
} from "./provisioning-state";
import { clearTakeoverAvatarStash } from "@/lib/billing/takeover-avatar-stash";
import { TakeoverBackdrop } from "./takeover-backdrop";
import { useAssistantDomains } from "./use-assistant-domains";
import { useProProvisioning } from "./use-pro-provisioning";
import { useTakeoverSurface } from "./use-takeover-surface";

type WizardStep = "provisioning" | "domain" | "complete";

/**
 * Leaving the takeover changes the modal's shape and its theme in one frame,
 * which neither transitions cheaply. So a sheet in the takeover's own colour
 * covers it first: fading that in reads as the content dissolving (it matches
 * what is already on screen), the swap happens out of sight, and the sheet
 * then clears to reveal the card.
 */
type TakeoverExit = "idle" | "covering" | "revealing";
const TAKEOVER_COVER_MS = 200;
const TAKEOVER_REVEAL_MS = 380;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

const isMachineBusy = (state: ProvisioningStateKind) =>
  state === "WAITING" || state === "RESIZING" || state === "STALLED";
const isSettled = (state: ProvisioningStateKind) =>
  state === "DONE" || state === "NOT_APPLICABLE";

const EMPTY_DIMENSIONS: ProvisioningDimensions = {
  machineSize: null,
  storageGib: null,
};

export interface BillingOnboardingModalProps {
  open: boolean;
  onClose: () => void;
  /** Test hook — forwarded to the provisioning screen's celebration dwell. */
  dwellMs?: number;
  /** Test hook — forwarded to the provisioning screen's per-phase minimum. */
  phaseMinMs?: number;
  /**
   * "checkout" (default): post-Stripe base→Pro onboarding — optimistic domain
   * routing, reads the stashed checkout intent.
   * "resize": observe an in-place plan change whose grow-only resize the
   * platform already fired server-side — no checkout intent, and the domain
   * step shows only when it is newly usable (entitled AND no domain yet).
   */
  mode?: "checkout" | "resize";
  /**
   * Resize mode only: the credit tier applied by an in-place change, forwarded
   * to the takeover. Ignored in checkout mode, where credits ride the stashed
   * intent instead. See `ProvisioningStateProps.resizeCredits`.
   */
  resizeCredits?: CreditTierEnum | null;
}

export function BillingOnboardingModal({
  open,
  onClose,
  dwellMs,
  phaseMinMs,
  mode = "checkout",
  resizeCredits,
}: BillingOnboardingModalProps) {
  const isResize = mode === "resize";
  const queryClient = useQueryClient();
  const [step, setStep] = useState<WizardStep>("provisioning");
  const [takeoverExit, setTakeoverExit] = useState<TakeoverExit>("idle");
  const exitTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [intent, setIntent] = useState<CheckoutIntent | null>(null);
  // The phase the takeover currently has on screen, which lags the live one by
  // up to the per-phase hold. Null until the takeover first reports.
  const [displayedPhase, setDisplayedPhase] =
    useState<ProvisioningStateKind | null>(null);
  // Wall-clock fence for the resize-mode domains read, mirroring the provisioning
  // hook's `openedAt`: only a domains response fetched at/after this instant is
  // trusted for routing. Null while closed.
  const [domainsOpenedAt, setDomainsOpenedAt] = useState<number | null>(null);
  // Gates the "Continue in the background" exit behind a confirm that warns
  // chatting stays unavailable until the upgrade finishes.
  const [backgroundConfirmOpen, setBackgroundConfirmOpen] = useState(false);

  // The hook owns the on-open subscription/onboarding cache invalidation and
  // every provisioning poll; it keeps tracking across step changes so a
  // backgrounded resize still resolves while the user sets up their domain.
  const provisioning = useProProvisioning({ open });

  // Whether this wizard has actually been opened, so the reset branch below can
  // tell a close from the mount of an instance that is simply rendered closed
  // (the billing page mounts two of these; only one opens). Its overlap with
  // `domainsOpenedAt` is deliberate: tying the stash lifecycle to a
  // domains-freshness fence would couple two unrelated concerns.
  const hasOpenedRef = useRef(false);

  useEffect(() => {
    if (open) {
      hasOpenedRef.current = true;
      setIntent(isResize ? null : readPurchasedCheckoutIntent());
      // Fence the domains freshness check to this open before any domains fetch
      // can land, so a pre-open cached list never reads as fresh.
      setDomainsOpenedAt((prev) => prev ?? Date.now());
      return;
    }
    // Closing mid-exit must drop the queued step change with it, or it lands
    // while the wizard is closed and a reopen starts on the wrong step.
    exitTimers.current.forEach(clearTimeout);
    exitTimers.current = [];
    setStep("provisioning");
    setTakeoverExit("idle");
    setDisplayedPhase(null);
    setDomainsOpenedAt(null);
    setBackgroundConfirmOpen(false);
    if (hasOpenedRef.current) {
      hasOpenedRef.current = false;
      // On close, not at the complete step: the takeover's exit sheet still
      // paints from this surface, so bumping the stash version mid-fade would
      // slide an otherwise-empty avatar query's tint to bundled green.
      clearTakeoverAvatarStash();
    }
  }, [open, isResize]);

  useEffect(
    () => () => {
      exitTimers.current.forEach(clearTimeout);
    },
    [],
  );

  useEffect(() => {
    if (step === "complete") {
      clearCheckoutIntent();
    }
  }, [step]);

  // Domain/email/guardian registration must run while the assistant's machine
  // is online: registering the email triggers a guardian-channel write to the
  // machine's gateway. The platform auto-resizes (and restarts) the machine
  // right after checkout, so the domain step stays guarded (submit disabled)
  // while that resize is in flight — including a stall, where the machine may
  // still be mid-restart.
  const machineBusy = isMachineBusy(provisioning.state);

  // The lock describes the screen the user is looking at, so it reads the
  // takeover's held phase rather than the live one. The domain step still keys
  // its submit guard off live provisioning, so a resize that finishes after a
  // genuine advance into that step unblocks it the moment it settles.
  const onScreenPhase = displayedPhase ?? provisioning.state;
  const onScreenSettled = isSettled(onScreenPhase);

  const { targets, assistantId, domainStepAvailable, onboardingSettled } =
    provisioning;

  // The takeover and the sheet that covers it on the way out paint from one
  // surface: the tint published as a custom property, plus the same blurred
  // backdrop a custom-image avatar shows — so the handoff can't cross-fade a
  // colour or an image against a flat fill.
  const { tintHex, backdropImageUrl } = useTakeoverSurface(assistantId);

  // Resize-mode routing needs "is a domain already registered?", which
  // checkout mode never consults — DomainStep owns its own fetch there. The
  // enabled gate keeps this query fully off in checkout mode and in resize
  // flows with no domain step to offer — a fee-less Mighty-tier package, or no
  // assistant to attach a domain to.
  const domainAnswerNeeded = isResize && domainStepAvailable === true;
  const {
    domains,
    domainsError,
    domainsFetching,
    domainsUpdatedAt,
    domainsErrorUpdatedAt,
  } = useAssistantDomains(open && domainAnswerNeeded, assistantId);
  const hasExistingDomain = (domains?.results.length ?? 0) > 0;

  // The domains list is a shared query — the billing page's finish-setup notice
  // reads it too — with a staleTime, so opening this modal can be served that
  // recently-cached list without a refetch. Force one refetch for this open the
  // moment the query is enabled, exactly as use-pro-provisioning invalidates the
  // subscription and onboarding queries on open; without it a fresh-enough cache
  // never advances `domainsUpdatedAt` past the fence and routing strands,
  // leaving the escape CTA (which closes the takeover) as the only way out.
  //
  // `assistantId` can CHANGE mid-open: `provisioning.assistantId` starts on the
  // active assistant and flips to the onboarding payload's primary once that
  // lands fresh (multi-assistant orgs). Track the id we last invalidated rather
  // than a plain "did we invalidate?" boolean, so the refetch re-fires for the
  // primary too — otherwise a primary whose list is already cached within
  // staleTime would never cross the fence and routing would strand.
  const domainsInvalidatedForIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      domainsInvalidatedForIdRef.current = null;
      return;
    }
    if (!domainAnswerNeeded || assistantId == null) {
      return;
    }
    if (domainsInvalidatedForIdRef.current === assistantId) {
      return;
    }
    domainsInvalidatedForIdRef.current = assistantId;
    void queryClient.invalidateQueries({
      queryKey: assistantsDomainsListQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
  }, [open, domainAnswerNeeded, assistantId, queryClient]);

  // "Answered" must mean a domains response fetched during THIS open, not merely
  // one already sitting in the shared cache. Mirror the onboarding freshness
  // guard: require the answer to cross the open fence (and not be mid-refetch)
  // before trusting it, so a stale empty cache can't latch routing with
  // hasExistingDomain=false and route to the domain step when a domain exists.
  // Both outcomes are fenced by their own timestamp: success by `dataUpdatedAt`,
  // error by `errorUpdatedAt`. A cached error left by a pre-open failed refetch
  // (React Query keeps `isError` set with the OLD list while the forced on-open
  // refetch is still in flight) must NOT read as answered — otherwise routing
  // latches on the stale list before the fresh response lands. A genuine
  // post-open error still counts as answered: routing then advances on whatever
  // list React Query retained — the domain step when none is known, complete
  // when a retained list still shows a domain — degrading gracefully either way.
  const domainsFreshData =
    domainsOpenedAt != null && domainsUpdatedAt >= domainsOpenedAt;
  const domainsFreshError =
    domainsOpenedAt != null &&
    Boolean(domainsError) &&
    domainsErrorUpdatedAt >= domainsOpenedAt;
  const domainsKnown =
    !domainsFetching && (domainsFreshData || domainsFreshError);
  // Routing must never use a stale `domainStepAvailable`: until the first
  // post-confirm fetch settles, TanStack may still serve pre-checkout cached
  // data. The celebration dwell and the DONE advance wait on this; the escape
  // CTA does not — it gates only on the machine being busy and the escape
  // window having elapsed. Latched: once fresh data has landed, a later
  // background refetch must not restart the dwell or flip the routing decision.
  const [routingSettled, setRoutingSettled] = useState(false);
  const routingInputsSettled =
    onboardingSettled && (!domainAnswerNeeded || domainsKnown);
  useEffect(() => {
    if (!open) {
      setRoutingSettled(false);
      return;
    }
    if (routingInputsSettled) {
      setRoutingSettled(true);
    }
  }, [open, routingInputsSettled]);

  const advanceFromProvisioning = useCallback(() => {
    // Checkout treats unknown availability optimistically (`undefined` → domain
    // step); resize requires affirmative `domainStepAvailable === true` AND no
    // existing domain before it surfaces the newly-usable domain step.
    const next = isResize
      ? domainStepAvailable === true && !hasExistingDomain
        ? "domain"
        : "complete"
      : domainStepAvailable === false
        ? "complete"
        : "domain";
    if (prefersReducedMotion()) {
      setStep(next);
      return;
    }
    setTakeoverExit("covering");
    exitTimers.current.push(
      setTimeout(() => {
        // Both the geometry and the theme change here, under the sheet.
        setStep(next);
        setTakeoverExit("revealing");
        exitTimers.current.push(
          setTimeout(() => setTakeoverExit("idle"), TAKEOVER_REVEAL_MS),
        );
      }, TAKEOVER_COVER_MS),
    );
  }, [domainStepAvailable, isResize, hasExistingDomain]);

  // "Continue in the background" opens a confirm that warns chatting stays
  // unavailable until the upgrade finishes, so the user chooses to keep waiting
  // or to be handed back to the app while the machine is still restarting.
  const escapeProvisioning = useCallback(() => {
    setBackgroundConfirmOpen(true);
  }, []);

  // Confirming the exit kicks the idempotent ensure-provisioned reconcile, shows
  // an error-aware toast, dismisses the confirm, and closes the takeover so the
  // user is handed back to the app rather than parked on the email/All-set steps
  // mid-provisioning.
  const confirmBackgroundExit = useCallback(() => {
    provisioning.kickProvisioning();
    toast.info(
      provisioning.kickError != null
        ? "We'll retry your upgrade in the background."
        : "Your upgrade continues in the background.",
    );
    setBackgroundConfirmOpen(false);
    onClose();
  }, [provisioning, onClose]);

  // Cancelling keeps the user on the takeover, still waiting on the upgrade.
  const cancelBackgroundExit = useCallback(() => {
    setBackgroundConfirmOpen(false);
  }, []);

  // The fetch-error variant of the provisioning step is a standard dismissible
  // card, not the locked full-bleed takeover — otherwise the light error UI is
  // marooned in the dark full-screen viewport and the user can't act on it.
  const provisioningError =
    step === "provisioning" &&
    (provisioning.confirmError || provisioning.targetsError);

  // The live provisioning takeover is the user's first real touchpoint with the
  // flow; we lock it so an accidental backdrop click or Esc can't bail them out
  // mid-provisioning. Sanctioned exits (the escape hatch and the timeout
  // actions) live inside the step content.
  const isTakeover = step === "provisioning" && !provisioningError;

  // Lock Esc/backdrop while provisioning is active. The takeover exposes no
  // persistent close control, but the in-content "Continue in the background"
  // button is independent of routing freshness — it needs only the machine busy
  // and the escape window elapsed — so a hung routing refetch can't strand the
  // user. Only a terminal ready state unlocks the backdrop itself.
  const lockTakeover = isTakeover && !onScreenSettled;

  // Full-bleed dark content that fills the viewport for the takeover.
  const provisioningContentClass =
    "overflow-y-auto inset-0 max-w-none w-screen h-screen max-h-none rounded-none border-0";

  // The backdrop goes from a 50% scrim to solid black as the takeover opens.
  // Easing that colour keeps the room darkening rather than blinking; padding
  // isn't animatable and rides along with the geometry.
  const overlayClass = `transition-[background-color] duration-300 ease-out${
    isTakeover ? " bg-black p-0" : ""
  }`;

  const stepEntrance = isTakeover
    ? "[animation:fadeIn_0.45s_ease-out_both]"
    : takeoverExit === "revealing"
      ? "[animation:fadeInUp_0.42s_ease-out_0.12s_both]"
      : "[animation:fadeIn_0.25s_ease-out_both]";

  return (
    <>
      <Modal.Root
        open={open}
        onOpenChange={(o) => {
          if (!o) {
            onClose();
          }
        }}
      >
        <Modal.Content
          size="md"
          // The final step is terminal — nothing is in flight to interrupt, so
          // it gets the standard dismiss. Earlier steps keep exits in-content.
          hideCloseButton={step !== "complete"}
          dismissOnOverlayClick={!lockTakeover}
          onEscapeKeyDown={lockTakeover ? (e) => e.preventDefault() : undefined}
          onInteractOutside={
            lockTakeover ? (e) => e.preventDefault() : undefined
          }
          data-theme={isTakeover ? "dark" : undefined}
          overlayClassName={overlayClass}
          className={isTakeover ? provisioningContentClass : "overflow-hidden"}
          style={{ [TAKEOVER_SURFACE_VAR]: tintHex } as CSSProperties}
        >
          {/* Keyed on step so the fade replays as we swap takeover ⇄ card. The
              takeover is the modal's opening step, so it mounts at full size
              rather than growing into it — it gets a longer, softer entrance so
              a full-bleed dark canvas doesn't just appear over the billing page. */}
          <div
            key={step}
            className={`flex min-h-0 flex-1 flex-col motion-reduce:[animation:none] ${stepEntrance}`}
          >
            {renderStep()}
          </div>
          {takeoverExit !== "idle" && (
            <div
              aria-hidden
              data-testid="takeover-exit-sheet"
              className={
                // `fixed` escapes the card's box once the modal has shrunk back,
                // so the sheet still covers the viewport while it clears.
                // Reversed fadeIn is the fade-out; no second keyframe needed.
                `pointer-events-none fixed inset-0 z-50 ${
                  takeoverExit === "covering"
                    ? "[animation:fadeIn_200ms_ease-in_both]"
                    : "[animation:fadeIn_380ms_ease-out_both_reverse]"
                }`
              }
              style={{ backgroundColor: TAKEOVER_SURFACE }}
            >
              {/* A custom-image takeover's colour lives in this blurred image,
                  not the ground fill, so the sheet reproduces it to match. The
                  `TAKEOVER_SURFACE` fill shows through while it decodes. The
                  sheet's own fade drives the reveal, so the backdrop doesn't
                  re-fade over it. */}
              {backdropImageUrl && (
                <TakeoverBackdrop
                  imageUrl={backdropImageUrl}
                  animateIn={false}
                />
              )}
            </div>
          )}
        </Modal.Content>
      </Modal.Root>
      {/* Stacks over the locked full-bleed takeover as its own Modal.Root; its
          Escape/backdrop closes only this confirm, never the takeover behind. */}
      <ConfirmDialog
        // Gated on the live machine state too: a resize that settles while the
        // confirm is open closes it declaratively, so its buttons can't act
        // after the wizard has advanced past provisioning.
        open={backgroundConfirmOpen && machineBusy}
        title="Continue in the background?"
        message="Your assistant is still upgrading. Chatting won't be available until it finishes — you can keep waiting here, or continue and we'll let you know when it's ready."
        confirmLabel="Continue"
        cancelLabel="Keep waiting"
        onConfirm={confirmBackgroundExit}
        onCancel={cancelBackgroundExit}
      />
    </>
  );

  function renderStep() {
    if (step === "provisioning") {
      if (provisioning.confirmError || provisioning.targetsError) {
        return <FetchErrorState onGoToBilling={onClose} />;
      }
      return (
        <ProvisioningState
          state={provisioning.state}
          softWaiting={provisioning.softWaiting}
          intent={intent}
          resizeCredits={isResize ? resizeCredits : undefined}
          targets={targets ?? EMPTY_DIMENSIONS}
          fromSnapshot={provisioning.actualsSnapshot ?? EMPTY_DIMENSIONS}
          celebrating={routingSettled}
          onCelebrationEnd={advanceFromProvisioning}
          assistantId={assistantId}
          escapeAvailable={machineBusy && provisioning.escapeEligible}
          onEscape={escapeProvisioning}
          onPhaseChange={setDisplayedPhase}
          kickError={provisioning.kickError}
          confirm={{
            onRetry: provisioning.retryConfirm,
            onGoToBilling: onClose,
          }}
          dwellMs={dwellMs}
          phaseMinMs={phaseMinMs}
        />
      );
    }

    if (step === "domain") {
      return (
        <DomainStep
          machineBusy={machineBusy}
          assistantId={assistantId}
          onExit={() => setStep("complete")}
        />
      );
    }

    return <CompleteState assistantId={assistantId} />;
  }
}
