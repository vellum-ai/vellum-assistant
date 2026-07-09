/**
 * Effective capabilities — trust-class capabilities COMPOSED with runtime context.
 *
 * `resolveCapabilities` (`capabilities.ts`) answers "what may this trust class
 * do" from the actor's class alone, and stays deliberately pure (no context
 * dependencies) so it remains the single fail-closed trust boundary. Some real
 * decisions additionally depend on runtime context — the channel a request
 * arrived on, surface actions, task authorization. Those compositions belong
 * here, in named/testable helpers, rather than re-derived inline at each call
 * site (which scatters a single policy across the codebase).
 *
 * Scope: this module composes capabilities with *actor/request* context. It does
 * not read global config itself — callers resolve those inputs and pass the
 * result in, keeping this layer focused on the capability composition.
 * `resolveRoutingState` in `trust-context-resolver.ts` is the same shape
 * (capability + guardian-route context → `promptWaitingAllowed`) and predates
 * this module; it stays where it is.
 */
import type { TrustClass } from "./actor-trust-resolver.js";
import { resolveCapabilities } from "./capabilities.js";

type RawTrustClass = TrustClass | (string & {}) | undefined;

/**
 * Channels that are themselves privileged document surfaces. Actors on these get
 * privileged document access regardless of trust class — the `vellum` first-party
 * console is the operator's own surface, not an external contact channel.
 */
const PRIVILEGED_DOCUMENT_CHANNELS = new Set<string>(["vellum"]);

/**
 * Whether an actor may perform privileged (non-conversation-scoped) document
 * operations. True when the trust class grants it OR the request arrived on a
 * privileged channel.
 */
export function canActOnPrivilegedDocuments(actor: {
  trustClass: RawTrustClass;
  executionChannel?: string;
}): boolean {
  return (
    resolveCapabilities(actor.trustClass).canAccessPrivilegedDocuments ||
    (actor.executionChannel != null &&
      PRIVILEGED_DOCUMENT_CHANNELS.has(actor.executionChannel))
  );
}

/**
 * Whether the untrusted shell lockdown applies to this actor. Active when the
 * actor's trust class cannot run an unsandboxed shell (i.e. any non-guardian
 * actor). The lockdown is unconditional — the former `ces-shell-lockdown`
 * feature flag was never enabled and has been removed, so the protection is
 * always active for untrusted actors.
 *
 * When active, the bash and host_bash tools inject `VELLUM_UNTRUSTED_SHELL=1`
 * into the child process environment so nested `assistant` CLI commands can
 * self-deny raw secret/token reveal flows. The bash tool also blocks proxied
 * credential sessions and credential-id references for untrusted actors.
 */
export function isUntrustedShellActive(actor: {
  trustClass: RawTrustClass;
}): boolean {
  return !resolveCapabilities(actor.trustClass).canRunUnsandboxedShell;
}

/**
 * Whether an archive-by-sender invocation is authorized. Any one of a surface
 * action, a task-batch authorization, or an explicit prompt approval suffices.
 * Absent those, the actor's own `user_approved` flag only counts when its trust
 * class may self-authorize archive-by-sender.
 */
export function isArchiveBySenderAuthorized(args: {
  trustClass: RawTrustClass;
  triggeredBySurfaceAction?: boolean;
  batchAuthorizedByTask?: boolean;
  approvedViaPrompt?: boolean;
  userApproved?: boolean;
}): boolean {
  const selfAuthorized =
    args.userApproved === true &&
    resolveCapabilities(args.trustClass).canSelfAuthorizeArchiveBySender;
  return (
    args.triggeredBySurfaceAction === true ||
    args.batchAuthorizedByTask === true ||
    args.approvedViaPrompt === true ||
    selfAuthorized
  );
}
