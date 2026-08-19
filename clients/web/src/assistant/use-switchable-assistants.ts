/**
 * The assistants the sidebar's ambient switcher can offer, and whether the
 * switcher affordance should render at all.
 *
 * The list mirrors the chooser screen's derivation: org-valid entries with a
 * transport from this device, kept only where a switch can actually succeed
 * (a paired entry is session-free, a local entry needs a local client, and
 * everything else needs the platform session). The gate reuses the flag pair
 * `useGatedSelectedAssistantId` honors, multi-platform-assistant or
 * assistant-switcher, and closes in gateway-auth mode, where the selection is
 * not this client's to change. Unlike that hook it does not require an org
 * id: a flag-on local client with two local assistants must still switch,
 * and `assistantsValidForOrg` passes org-less entries regardless.
 */

import { useMemo } from "react";

import { isGatewayAuthMode } from "@/lib/auth/gateway-session";
import { isLocalClient } from "@/lib/local-mode";
import { useHasPlatformSession } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
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
  const multiPlatformAssistant =
    useClientFeatureFlagStore.use.multiPlatformAssistant();
  const assistantSwitcher = useClientFeatureFlagStore.use.assistantSwitcher();
  const organizationId = useRequestOrganizationId();
  const allAssistants = useResolvedAssistantsStore.use.assistants();
  const hasPlatformSession = useHasPlatformSession();
  const localClient = isLocalClient();

  const gateOpen =
    (multiPlatformAssistant || assistantSwitcher) && !isGatewayAuthMode();

  const assistants = useMemo(
    () =>
      assistantsValidForOrg(allAssistants, organizationId)
        .filter(isConnectableFromThisDevice)
        .filter(
          (a) => a.isPaired || (a.isLocal && localClient) || hasPlatformSession,
        ),
    [allAssistants, organizationId, localClient, hasPlatformSession],
  );

  return { assistants, canSwitch: gateOpen && assistants.length >= 2 };
}
