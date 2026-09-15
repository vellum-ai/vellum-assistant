/**
 * IPC-only methods for plugin-resident skill script execution and scoped
 * credential resolution.
 *
 * The daemon issues conversation-bound invocation grants and is the only
 * process that may map a grant back to a plugin owner. These methods are
 * registered directly on the assistant IPC server and never enter ROUTES
 * or OpenAPI.
 */

import { z } from "zod";

import { resolveCredentialForPluginSkillGrant } from "../../plugins/plugin-skill-invocation.js";
import { runPluginSkillScript } from "../../plugins/plugin-skill-script-runner.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../../runtime/routes/errors.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

export const PLUGIN_SKILL_RUN_IPC_METHOD = "plugin_skill_run";
export const PLUGIN_SKILL_RESOLVE_CREDENTIAL_IPC_METHOD =
  "plugin_skill_resolve_credential";

const PluginSkillRunParamsSchema = z.object({
  conversationId: z.string().min(1),
  skillId: z.string().min(1),
  script: z.string().min(1),
  args: z.array(z.string()).optional(),
  revealNonce: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const PluginSkillResolveCredentialParamsSchema = z.object({
  grant: z.string().min(1),
  ref: z.string().min(1),
  conversationId: z.string().min(1).optional(),
});

export async function handlePluginSkillRun({
  body = {},
  abortSignal,
}: RouteHandlerArgs): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const params = PluginSkillRunParamsSchema.parse(body);
  const result = await runPluginSkillScript({
    conversationId: params.conversationId,
    skillId: params.skillId,
    script: params.script,
    args: params.args,
    revealNonce: params.revealNonce,
    timeoutMs: params.timeoutMs,
    abortSignal,
  });
  if (!result.ok) {
    throw routeErrorForScriptFailure(result.reason, result.message);
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

export async function handlePluginSkillResolveCredential({
  body = {},
}: RouteHandlerArgs): Promise<{ value: string }> {
  const params = PluginSkillResolveCredentialParamsSchema.parse(body);
  const result = await resolveCredentialForPluginSkillGrant(
    params.grant,
    params.ref,
    { conversationId: params.conversationId },
  );
  if (!result.ok) {
    throw routeErrorForCredentialFailure(result.reason, result.message);
  }
  return { value: result.value };
}

function routeErrorForScriptFailure(
  reason: string,
  message: string,
): Error {
  switch (reason) {
    case "missing_conversation":
    case "invalid_script":
      return new BadRequestError(message);
    case "invalid_nonce":
      return new UnauthorizedError(message);
    case "conversation_not_live":
    case "skill_not_found":
      return new NotFoundError(message);
    case "not_plugin_owned":
    case "skill_not_active":
      return new ForbiddenError(message);
    default:
      return new BadRequestError(message);
  }
}

function routeErrorForCredentialFailure(
  reason: string,
  message: string,
): Error {
  switch (reason) {
    case "invalid_grant":
      return new UnauthorizedError(message);
    case "out_of_scope":
      return new ForbiddenError(message);
    case "not_found":
      return new NotFoundError(message);
    case "unreachable":
      return new ServiceUnavailableError(message);
    default:
      return new BadRequestError(message);
  }
}

export const PLUGIN_SKILL_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  [PLUGIN_SKILL_RUN_IPC_METHOD]: handlePluginSkillRun,
  [PLUGIN_SKILL_RESOLVE_CREDENTIAL_IPC_METHOD]:
    handlePluginSkillResolveCredential,
};
