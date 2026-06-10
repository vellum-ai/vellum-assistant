import { useOrganizationStore } from "@/stores/organization-store";
import {
  assistantsValidForOrg,
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";

/**
 * Resolved assistants usable under the active org. Recomputes when the
 * assistant list or the active org changes.
 */
export function useValidAssistantsForActiveOrg(): ResolvedAssistant[] {
  const assistants = useResolvedAssistantsStore.use.assistants();
  const activeOrgId = useOrganizationStore.use.currentOrganizationId();
  return assistantsValidForOrg(assistants, activeOrgId);
}
