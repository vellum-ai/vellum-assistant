/**
 * Shared setup for the wizard steps that render in the ordinary modal box
 * rather than the full-bleed takeover: the assistant fixture their reads
 * resolve, and the box itself.
 *
 * Not a `.stories.tsx` file, so Storybook does not index it.
 */
import type { ReactNode } from "react";
import { Modal } from "@vellumai/design-library/components/modal";

import type { Assistant } from "@/generated/api/types.gen";

/** An assistant on Pro, as the platform serves it. */
export function makeStoryAssistant(id: string): Assistant {
  return {
    id,
    name: "Velly",
    handle: "velly",
    avatar_url: null,
    description: null,
    status: "active",
    created: "2026-07-01T00:00:00Z",
    modified: "2026-07-01T00:00:00Z",
    release_channel: "stable",
    current_release_version: "0.12.0",
    machine_id: null,
    vembda_cluster_id: null,
    machine_size: "large",
    provisioned_storage_gib: 100,
    maintenance_mode: { enabled: false, debug_pod_name: null },
    is_local: false,
    ingress_url: null,
    platform_actor_token: null,
    access_consented: true,
  };
}

/**
 * The content box `BillingOnboardingModal` gives every step but the takeover,
 * mounted through the real `Modal.Root` / `Modal.Content` so a card's
 * overhanging creatures are clipped the way the app clips them.
 *
 * `hideCloseButton` follows the modal's own rule: only the terminal complete
 * step, where nothing is in flight to interrupt, gets the standard dismiss.
 */
export function WizardStepBox({
  children,
  hideCloseButton = false,
}: {
  children: ReactNode;
  hideCloseButton?: boolean;
}) {
  return (
    <Modal.Root open>
      <Modal.Content
        size="md"
        hideCloseButton={hideCloseButton}
        className="overflow-hidden"
      >
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </Modal.Content>
    </Modal.Root>
  );
}
