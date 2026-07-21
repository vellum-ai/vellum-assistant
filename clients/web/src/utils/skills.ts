/**
 * Cross-domain skill helpers shared by the intelligence Skills surfaces and
 * the chat skill-detail panel: the removability rule and skills-list cache
 * invalidation. They live here (not in `domains/intelligence/`) so the two
 * surfaces cannot diverge — see `local/no-cross-domain-imports`.
 */

import type { QueryClient } from "@tanstack/react-query";

import { skillsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { SkillsGetResponses } from "@/generated/daemon/types.gen";

type GeneratedSkill = SkillsGetResponses[200]["skills"][number];

/**
 * Only installed skills can be removed — bundled skills ship with the
 * assistant and the daemon rejects deletes for anything but installed skills.
 * Typed structurally on `kind` so it accepts both the domain `SkillInfo`
 * view-model and skills straight off the wire (e.g. the single-skill
 * response the chat panel renders).
 */
export function isRemovableSkill(skill: Pick<GeneratedSkill, "kind">): boolean {
  return skill.kind === "installed";
}

/**
 * Invalidate the skills-list caches for one assistant. Scoped by
 * `assistant_id` and nothing else: TanStack's partial key matching means
 * every `skillsGet` entry for that assistant refetches regardless of query
 * params (`include=catalog`, kind/origin filters, ...), while other
 * assistants' caches are left alone.
 */
export function invalidateSkillsList(
  queryClient: QueryClient,
  assistantId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: skillsGetQueryKey({ path: { assistant_id: assistantId } }),
  });
}
