/**
 * IPC-only companion-file methods behind `assistant skills companion …`.
 *
 * Companion files are the reference material a managed skill ships alongside
 * its SKILL.md — most often a `scripts/` helper the assistant proved works and
 * wants to rerun verbatim rather than re-derive. Creating the skill itself
 * stays on the `scaffold_managed_skill` tool, which owns the side effects a
 * create fans out (capability-memory refresh, skill card, authoring counter,
 * conversation lineage). Adding a file to a skill that already exists needs
 * none of them: capability memories derive from frontmatter, and companion
 * files are read from disk at skill-load time, so a file that lands later is
 * picked up on the next load.
 *
 * No HTTP surface. These verbs write into the workspace skills directory on
 * behalf of a local caller; the gateway has no reason to reach them, so they
 * are registered directly on the IPC server (see `assistant-server.ts`) and
 * never enter the shared `ROUTES` array.
 */

import { z } from "zod";

import { BadRequestError, NotFoundError } from "../../runtime/routes/errors.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";
import {
  addCompanionFile,
  listCompanionFiles,
  removeCompanionFile,
} from "../../skills/managed-store.js";

const AddParamsSchema = z.object({
  skillId: z.string().min(1),
  path: z.string().min(1),
  from: z.string().min(1),
  overwrite: z.boolean().optional(),
});

const ListParamsSchema = z.object({
  skillId: z.string().min(1),
});

const RemoveParamsSchema = z.object({
  skillId: z.string().min(1),
  path: z.string().min(1),
});

/**
 * The store returns a `not found` error for a missing skill and a validation
 * error for everything else; map the former to 404 so the CLI's exit code
 * distinguishes "no such skill" from "rejected".
 */
function throwStoreError(error: string): never {
  if (error.includes("not found")) {
    throw new NotFoundError(error);
  }
  throw new BadRequestError(error);
}

export function handleSkillsCompanionAdd({ body = {} }: RouteHandlerArgs) {
  const params = AddParamsSchema.parse(body);
  const result = addCompanionFile({
    skillId: params.skillId,
    path: params.path,
    sourcePath: params.from,
    overwrite: params.overwrite,
  });
  if (!result.added) {
    throwStoreError(result.error ?? "failed to add companion file");
  }
  return { added: true, skillId: params.skillId, path: result.path };
}

export function handleSkillsCompanionList({ body = {} }: RouteHandlerArgs) {
  const params = ListParamsSchema.parse(body);
  const result = listCompanionFiles(params.skillId);
  if ("error" in result) {
    throwStoreError(result.error);
  }
  return { skillId: params.skillId, files: result.files };
}

export function handleSkillsCompanionRemove({ body = {} }: RouteHandlerArgs) {
  const params = RemoveParamsSchema.parse(body);
  const result = removeCompanionFile(params.skillId, params.path);
  if (!result.removed) {
    throwStoreError(result.error ?? "failed to remove companion file");
  }
  return { removed: true, skillId: params.skillId, path: params.path };
}

/**
 * IPC-only companion-file methods, keyed by IPC operationId. Registered
 * directly on the assistant IPC server (see `assistant-server.ts`).
 */
export const SKILLS_COMPANION_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  skills_companion_add: handleSkillsCompanionAdd,
  skills_companion_list: handleSkillsCompanionList,
  skills_companion_remove: handleSkillsCompanionRemove,
};
