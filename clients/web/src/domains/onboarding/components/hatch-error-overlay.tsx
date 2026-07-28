import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

import { PLATFORM_HOSTED_DISABLED_MESSAGE } from "@/assistant/lifecycle";

interface HatchErrorOverlayProps {
  /** Terminal failure message from the background hatch. */
  error: string;
  /** Re-run the failed hatch from the top. */
  onRetry: () => void;
}

/**
 * Terminal background-hatch failure, surfaced over the onboarding funnel.
 *
 * Layers on top of whatever step is on screen rather than replacing it, so the
 * funnel keeps its collected state and a successful retry resumes in place.
 * Retrying can't help while managed hosting is at capacity, so that case offers
 * the local-assistant off-ramp instead.
 */
export function HatchErrorOverlay({ error, onRetry }: HatchErrorOverlayProps) {
  const platformHostedDisabled = error === PLATFORM_HOSTED_DISABLED_MESSAGE;
  return (
    <Modal.Root open>
      <Modal.Content
        size="sm"
        role="alertdialog"
        hideCloseButton
        dismissOnOverlayClick={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <Modal.Header>
          <Modal.Title>Something went wrong</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Modal.Description>{error}</Modal.Description>
          {platformHostedDisabled ? (
            <p className="mt-5 text-body-medium-default text-[var(--content-default)]">
              Get started today with a local assistant
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          {platformHostedDisabled ? (
            <Button asChild variant="primary" size="regular" fullWidth>
              <a href={`${window.location.origin}/download`}>
                Download the macOS app
              </a>
            </Button>
          ) : (
            <Button
              variant="primary"
              size="regular"
              fullWidth
              onClick={onRetry}
            >
              Try again
            </Button>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
