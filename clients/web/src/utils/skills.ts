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

/**
 * Router state a chat surface attaches when opening the skill detail page
 * (`routes.skills.detail`), so the page's back affordances return to the
 * conversation the skill was opened from instead of the My Superpowers list.
 *
 * `skill-detail-page.tsx` is the one reader; it validates the value before
 * trusting it, so deep links and stale history entries degrade to the list.
 */
export function skillDetailBackState(location: {
  pathname: string;
  search: string;
  hash: string;
}): { backTo: string } {
  // `?prompt=` / `?relay=` are auto-send commands (use-auto-send-effects.ts).
  // Relay callers deliberately keep them in the URL after dispatch, so a
  // return trip would remount the chat view, reset its consumed-prompt ref,
  // and send the prompt again. Strip them from the return location.
  const params = new URLSearchParams(location.search);
  params.delete("prompt");
  params.delete("relay");
  const search = params.toString();
  return {
    backTo: `${location.pathname}${search ? `?${search}` : ""}${location.hash}`,
  };
}
