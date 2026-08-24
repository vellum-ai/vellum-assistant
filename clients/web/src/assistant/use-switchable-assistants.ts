/**
 * The assistants the sidebar's ambient switcher can offer, and whether the
 * switcher affordance should render at all.
 *
 * The list mirrors the chooser screen's derivation: org-valid entries with a
 * transport from this device, kept only where a switch can actually succeed
 * (a paired entry is session-free, a local entry needs a local client, and
 * everything else needs the platform session). The gate deliberately deviates
 * from `useGatedSelectedAssistantId` twice: it closes only in remote-gateway
 * mode (a served single-assistant session, where the selection is not this
 * client's to change) rather than in every gateway-authenticated session,
 * since a local or paired session holds a gateway token too and is exactly
 * where local switching works; and it does not require an org id, since a
 * local client with two local assistants must still switch and
 * `assistantsValidForOrg` passes org-less entries regardless.
 */

import { useMemo } from "react";

import { isLocalClient, isRemoteGatewayMode } from "@/lib/local-mode";
import { useHasPlatformSession } from "@/stores/auth-store";
import { useRequestOrganizationId } from "@/stores/organization-store";
import {
  assistantsValidForOrg,
  isConnectableFromThisDevice,
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";

export interface SwitchableAssistants {
  /** Org-valid, reachable, accessible entries, the active one included. */
  assistants: ResolvedAssistant[];
  /** Whether the switcher should render: gate open and two or more entries. */
  canSwitch: boolean;
}

export function useSwitchableAssistants(): SwitchableAssistants {
  const organizationId = useRequestOrganizationId();
  const allAssistants = useResolvedAssistantsStore.use.assistants();
  const hasPlatformSession = useHasPlatformSession();
  const localClient = isLocalClient();

  const assistants = useMemo(
    () =>
      assistantsValidForOrg(allAssistants, organizationId)
        .filter(isConnectableFromThisDevice)
        .filter(
          (a) => a.isPaired || (a.isLocal && localClient) || hasPlatformSession,
        ),
    [allAssistants, organizationId, localClient, hasPlatformSession],
  );

  return {
    assistants,
    canSwitch: !isRemoteGatewayMode() && assistants.length >= 2,
  };
}
